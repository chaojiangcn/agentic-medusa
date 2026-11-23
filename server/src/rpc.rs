//! Bidirectional JSON-RPC 2.0 transport, modelled on the Codex App Server.
//!
//! - `WebSocket /rpc` — one JSON-RPC message per text frame (browser clients)
//! - `stdio` (`--listen stdio://`) — newline-delimited JSONL (CLI / IDE clients)
//! - REST endpoints are kept as a compatibility shim for the existing UI.
//!
//! The server can *initiate* requests (`approval/request`), which suspends the
//! current turn until the client replies — the same pattern Codex uses for
//! tool approvals, here used for the boss's inspection gate.

use crate::config::ConfigStore;
use crate::protocol::*;
use crate::session::SessionStore;
use crate::workshop::{emit, initial_snapshot, project};
use crate::tools::{sample_args, ToolRegistry};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalReply {
    pub decision: String,
    #[serde(default)]
    pub note: String,
}

pub struct AppState {
    pub store: Mutex<SessionStore>,
    pub snapshot: Mutex<Snapshot>,
    pub config: ConfigStore,
    pub active_thread: Mutex<String>,
    pub tx: broadcast::Sender<String>,
    pub approvals: Mutex<HashMap<u64, oneshot::Sender<ApprovalReply>>>,
    pub next_id: AtomicU64,
    pub llm_calls: AtomicU64,
    pub initialized: AtomicBool,
}

impl AppState {
    pub fn new(config: ConfigStore, store: SessionStore) -> Arc<Self> {
        let thread = store
            .threads()
            .first()
            .map(|t| t.id.clone())
            .unwrap_or_else(|| "main".into());
        let mut snap = initial_snapshot(&thread);
        snap.threads = store.threads();
        let (tx, _rx) = broadcast::channel::<String>(512);
        Arc::new(Self {
            store: Mutex::new(store),
            snapshot: Mutex::new(snap),
            config,
            active_thread: Mutex::new(thread),
            tx,
            approvals: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            llm_calls: AtomicU64::new(0),
            initialized: AtomicBool::new(false),
        })
    }

    pub fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1_000_000
    }

    pub fn broadcast(&self, msg: RpcMessage) {
        if let Ok(text) = serde_json::to_string(&msg) {
            let _ = self.tx.send(text);
        }
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route("/api/protocol", get(protocol_info))
        .route("/api/history", get(history))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/threads", get(threads_handler))
        .route("/api/config", get(config_read))
        .route("/api/config", post(config_write))
        .route("/api/tools", get(tools_read))
        .route("/api/events", post(ingest))
        .route("/api/control", post(control))
        .route("/api/stream", get(sse))
        .route("/rpc", get(ws_handler))
        .with_state(state)
        .layer(middleware::from_fn(cors))
}

async fn cors(req: axum::extract::Request, next: Next) -> Response {
    let is_preflight = req.method() == Method::OPTIONS;
    let mut res = if is_preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Content-Type, Authorization".parse().unwrap(),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    res
}

async fn index() -> &'static str {
    "Medusa App Server — JSON-RPC 2.0 over ws://127.0.0.1:8787/rpc (or --listen stdio://)\n"
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "medusa-app-server",
        "userAgent": USER_AGENT,
        "protocolVersion": PROTOCOL_VERSION,
        "transport": ["websocket", "stdio", "rest-compat"],
        "clients": state.receiver_count(),
        "seq": state.store.lock().await.seq(),
        "llmCalls": state.llm_calls.load(Ordering::Relaxed),
        "mode": state.config.get().mode,
    }))
}

async fn protocol_info() -> impl IntoResponse {
    Json(json!({
        "protocol": "JSON-RPC 2.0 (bidirectional)",
        "version": PROTOCOL_VERSION,
        "handshake": ["initialize", "initialized"],
        "primitives": ["Thread", "Turn", "Item"],
        "requests": [
            "initialize", "thread/start", "thread/list", "thread/resume",
            "thread/fork", "thread/read", "turn/start", "turn/interrupt",
            "control", "config/read", "config/write", "event/ingest",
            "session/replay", "approval/respond", "tools/list", "tools/call"
        ],
        "notifications": [
            "thread/started", "turn/started", "turn/completed", "turn/interrupted",
            "item/started", "item/agentMessage/delta", "item/completed",
            "boss/patrol", "boss/inspection", "boss/intervention",
            "tool/call", "tool/result",
            "workshop/snapshot", "system/control", "config/updated", "session/event"
        ],
        "serverRequests": ["approval/request"],
        "sources": ["append-only JSONL session log"],
    }))
}

/// Replay: rebuild frames by projecting the log from the beginning. This is
/// the "state is a projection" guarantee — no separate stored truth.
/// Replay budget. Every frame embeds a full projection, so replaying a long
/// append-only log frame-by-frame turns into hundreds of MB over the wire.
/// The UI only keeps a sliding window, so the server sends the tail only.
const MAX_REPLAY_FRAMES: usize = 240;

pub async fn build_frames(state: &Arc<AppState>, thread_id: &str, after_seq: u64) -> Vec<Frame> {
    let events = {
        let store = state.store.lock().await;
        store.events_for(thread_id, after_seq)
    };
    let mut snap = initial_snapshot(thread_id);
    snap.threads = state.store.lock().await.threads();
    let start = events.len().saturating_sub(MAX_REPLAY_FRAMES);
    let mut frames = Vec::with_capacity(events.len() - start);
    for (index, ev) in events.iter().enumerate() {
        project(&mut snap, ev);
        if index >= start {
            frames.push(Frame {
                event: ev.clone(),
                snapshot: snap.clone(),
            });
        }
    }
    frames
}

async fn history(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let thread = state.active_thread.lock().await.clone();
    let mut frames = build_frames(&state, &thread, 0).await;
    if frames.len() > 2000 {
        frames = frames.split_off(frames.len() - 2000);
    }
    Json(frames)
}

async fn snapshot_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let snap = state.snapshot.lock().await.clone();
    Json(snap)
}

async fn threads_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "activeThread": state.active_thread.lock().await.clone(),
        "threads": state.store.lock().await.threads(),
    }))
}

/// REST view of the equipment ledger (a convenience shim over tools/list).
async fn tools_read(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match dispatch(&state, "tools/list", json!({})).await {
        Ok(value) => Json(value),
        Err((_, message)) => Json(json!({ "error": message })),
    }
}

async fn config_read(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.config.view())
}

async fn config_write(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<Value>,
) -> impl IntoResponse {
    match state.config.update(patch) {
        Ok(view) => {
            let thread = state.active_thread.lock().await.clone();
            let _ = emit(
                &state,
                SessionEvent::new(0, &thread, "config.updated", "human", json!({
                    "model": view.model, "mode": view.mode, "note": "设置面板更新了模型配置"
                })),
            )
            .await;
            (StatusCode::OK, Json(json!({ "ok": true, "config": view }))).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn ingest(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let thread = body
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_string();
    let kind = body
        .get("kind")
        .or_else(|| body.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("external.event")
        .to_string();
    let actor = body
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("external")
        .to_string();
    let payload = body.get("payload").cloned().unwrap_or_else(|| json!({}));
    let mut ev = SessionEvent::new(0, &thread, &kind, &actor, payload);
    if let Some(s) = body.get("stage").and_then(Value::as_str) {
        ev = ev.with_stage(s);
    }
    if let Some(s) = body.get("taskId").and_then(Value::as_str) {
        ev = ev.with_task(s);
    }
    if let Some(s) = body.get("workerId").and_then(Value::as_str) {
        ev = ev.with_worker(s);
    }
    if let Some(s) = body.get("turnId").and_then(Value::as_str) {
        ev = ev.with_turn(s);
    }
    if let Some(s) = body.get("itemId").and_then(Value::as_str) {
        ev = ev.with_item(s);
    }
    match emit_external(&state, ev).await {
        Ok(frame) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "seq": frame.event.seq })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn emit_external(state: &Arc<AppState>, ev: SessionEvent) -> anyhow::Result<Frame> {
    let (stored, frame) = {
        let mut store = state.store.lock().await;
        let stored = store.ingest(ev)?;
        let mut snap = state.snapshot.lock().await;
        project(&mut snap, &stored);
        snap.threads = store.threads();
        snap.turns = store.turns();
        snap.items = store.items();
        (stored.clone(), Frame { event: stored, snapshot: snap.clone() })
    };
    state.broadcast(RpcMessage::notification(
        "session/event",
        serde_json::to_value(&frame.event)?,
    ));
    state.broadcast(RpcMessage::notification(
        "workshop/snapshot",
        serde_json::to_value(&frame)?,
    ));
    Ok(frame)
}

#[derive(Debug, Deserialize)]
struct ControlBody {
    action: String,
    #[serde(default)]
    #[serde(rename = "workerId")]
    worker_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "stageId")]
    stage_id: Option<String>,
    #[serde(default)]
    value: Option<f64>,
}

async fn control(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ControlBody>,
) -> impl IntoResponse {
    let mut p = json!({ "action": body.action, "note": format!("人工介入 · {}", body.action) });
    if let Some(v) = body.worker_id {
        p["workerId"] = json!(v);
    }
    if let Some(v) = body.stage_id {
        p["stageId"] = json!(v);
    }
    if let Some(v) = body.value {
        p["value"] = json!(v);
    }
    let thread = state.active_thread.lock().await.clone();
    match emit(
        &state,
        SessionEvent::new(0, &thread, "system.control", "human", p),
    )
    .await
    {
        Ok(frame) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "seq": frame.event.seq })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

// SSE compatibility shim — the frontend's old EventSource still works.
async fn sse(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::stream::Stream;
    use std::convert::Infallible;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    struct FrameStream {
        rx: broadcast::Receiver<String>,
    }
    impl Stream for FrameStream {
        type Item = Result<Event, Infallible>;
        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            match self.rx.try_recv() {
                Ok(text) => {
                    if let Ok(msg) = serde_json::from_str::<RpcMessage>(&text) {
                        if msg.method.as_deref() == Some("workshop/snapshot") {
                            if let Some(params) = msg.params {
                                return Poll::Ready(Some(Ok(Event::default().data(
                                    serde_json::to_string(&params).unwrap_or_default(),
                                ))));
                            }
                        }
                    }
                    Poll::Ready(Some(Ok(Event::default().comment("event"))))
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => Poll::Pending,
                Err(broadcast::error::TryRecvError::Closed) => Poll::Ready(None),
            }
        }
    }

    Sse::new(FrameStream { rx: state.tx.subscribe() })
        .keep_alive(KeepAlive::default().interval(std::time::Duration::from_secs(15)))
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let mut sub = state.tx.subscribe();

    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(text) = out_rx.recv() => {
                    if sink.send(Message::Text(text.into())).await.is_err() { break; }
                }
                received = sub.recv() => {
                    match received {
                        Ok(text) => {
                            if sink.send(Message::Text(text.into())).await.is_err() { break; }
                        }
                        // A slow client must not kill its outbound channel:
                        // skip the backlog and keep streaming live frames.
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            eprintln!("ws subscriber lagged, skipped {skipped} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        handle_line(&state, &text, &out_tx).await;
    }
    writer.abort();
}

/// Handle one inbound JSON-RPC line. Shared by WebSocket and stdio.
pub async fn handle_line(state: &Arc<AppState>, line: &str, out: &mpsc::UnboundedSender<String>) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let msg: RpcMessage = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => {
            let _ = out.send(
                serde_json::to_string(&RpcMessage::err(
                    Value::Null,
                    -32700,
                    format!("parse error: {e}"),
                ))
                .unwrap(),
            );
            return;
        }
    };

    // A response to a server-initiated request (e.g. approval/request).
    if msg.method.is_none() && msg.id.is_some() {
        resolve_server_request(state, &msg).await;
        return;
    }

    let id = msg.id.clone().unwrap_or(Value::Null);
    let method = msg.method.clone().unwrap_or_default();
    let params = msg.params.clone().unwrap_or_else(|| json!({}));

    // Handshake gate, mirroring Codex: initialize must come first.
    let is_init = method == "initialize";
    let is_initialized_notif = method == "initialized";
    if !is_init && !is_initialized_notif && !state.initialized.load(Ordering::Relaxed) {
        reply(out, RpcMessage::err(id, ERR_NOT_INITIALIZED, "Not initialized"));
        return;
    }

    let result = dispatch(state, &method, params).await;
    match result {
        Ok(value) => {
            if msg.is_notification() {
                return; // notifications never get a response
            }
            reply(out, RpcMessage::ok(id, value));
        }
        Err(code) => {
            if !msg.is_notification() {
                reply(out, RpcMessage::err(id, code.0, code.1));
            }
        }
    }
}

fn reply(out: &mpsc::UnboundedSender<String>, msg: RpcMessage) {
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = out.send(text);
    }
}

async fn resolve_server_request(state: &Arc<AppState>, msg: &RpcMessage) {
    let Some(id) = msg.id.as_ref().and_then(Value::as_u64) else {
        return;
    };
    let decision = msg
        .result
        .as_ref()
        .and_then(|r| r.get("decision"))
        .and_then(Value::as_str)
        .unwrap_or("allow")
        .to_string();
    let note = msg
        .result
        .as_ref()
        .and_then(|r| r.get("note"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(tx) = state.approvals.lock().await.remove(&id) {
        let _ = tx.send(ApprovalReply { decision, note });
    }
}

type DispatchError = (i64, String);

async fn dispatch(
    state: &Arc<AppState>,
    method: &str,
    params: Value,
) -> Result<Value, DispatchError> {
    let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "initialize" => {
            state.initialized.store(true, Ordering::Relaxed);
            Ok(json!({
                "userAgent": USER_AGENT,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "bidirectional": true,
                    "serverRequests": ["approval/request"],
                    "replay": true,
                    "fork": true,
                    "stdio": true,
                    "websocket": true,
                    "tools": true,
                    "toolCall": true
                },
                "configHome": state.config.home.display().to_string(),
                "config": state.config.view(),
                "activeThread": state.active_thread.lock().await.clone(),
            }))
        }
        "initialized" => Ok(json!({ "ok": true })),

        "thread/start" => {
            let title = s("title");
            let mut store = state.store.lock().await;
            let id = format!("thread-{}", &crate::session::short_id()[..8]);
            let info = store
                .create_thread(&id, if title.is_empty() { "新班次" } else { &title }, None)
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            *state.active_thread.lock().await = id.clone();
            drop(store);
            rebuild_snapshot(state, &id).await;
            state.broadcast(RpcMessage::notification(
                "thread/started",
                json!({ "thread": info }),
            ));
            Ok(json!({ "thread": info }))
        }
        "thread/list" => {
            let store = state.store.lock().await;
            Ok(json!({
                "activeThread": state.active_thread.lock().await.clone(),
                "threads": store.threads()
            }))
        }
        "thread/read" => {
            let thread = if s("threadId").is_empty() {
                state.active_thread.lock().await.clone()
            } else {
                s("threadId")
            };
            let after = params.get("afterSeq").and_then(Value::as_u64).unwrap_or(0);
            let events = state.store.lock().await.events_for(&thread, after);
            let frames = build_frames(state, &thread, after).await;
            Ok(json!({
                "thread": state.store.lock().await.thread(&thread),
                "afterSeq": after,
                "events": events,
                "frames": frames
            }))
        }
        "thread/resume" => {
            let thread = if s("threadId").is_empty() {
                state.active_thread.lock().await.clone()
            } else {
                s("threadId")
            };
            if state.store.lock().await.thread(&thread).is_none() {
                return Err((ERR_INVALID_PARAMS, "unknown thread".into()));
            }
            *state.active_thread.lock().await = thread.clone();
            rebuild_snapshot(state, &thread).await;
            let frames = build_frames(state, &thread, 0).await;
            Ok(json!({
                "thread": state.store.lock().await.thread(&thread),
                "events": state.store.lock().await.events_for(&thread, 0),
                "frames": frames,
                "snapshot": state.snapshot.lock().await.clone(),
                "note": "已从 append-only 日志重建状态"
            }))
        }
        "thread/fork" => {
            let from = if s("threadId").is_empty() {
                state.active_thread.lock().await.clone()
            } else {
                s("threadId")
            };
            let at = params.get("atSeq").and_then(Value::as_u64);
            let info = state
                .store
                .lock()
                .await
                .fork(&from, at)
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            let id = info.id.clone();
            *state.active_thread.lock().await = id.clone();
            rebuild_snapshot(state, &id).await;
            state.broadcast(RpcMessage::notification(
                "thread/started",
                json!({ "thread": info, "forkedFrom": from }),
            ));
            Ok(json!({ "thread": info, "note": "老板开了一条支线" }))
        }

        "turn/start" => {
            let thread = state.active_thread.lock().await.clone();
            let title = if s("title").is_empty() {
                "人工投料工单".into()
            } else {
                s("title")
            };
            let task_id = format!("M{:03}", state.next_id.fetch_add(1, Ordering::Relaxed));
            let turn_id = format!("turn-{}", crate::session::short_id());
            let item_id = format!("item-{}-{}", task_id, crate::session::short_id());
            emit(
                state,
                SessionEvent::new(0, &thread, "turn.started", "human", json!({
                    "taskId": task_id, "title": title
                }))
                .with_turn(&turn_id)
                .with_task(&task_id),
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            emit(
                state,
                SessionEvent::new(0, &thread, "item.started", "w1", json!({
                    "kind": "agentMessage", "stageId": "intake"
                }))
                .with_turn(&turn_id)
                .with_item(&item_id)
                .with_task(&task_id)
                .with_worker("w1")
                .with_stage("intake"),
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            emit(
                state,
                SessionEvent::new(0, &thread, "item.agentMessage.delta", "w1", json!({
                    "delta": "人工投料：已接收，进入检索工位。", "tokens": 12
                }))
                .with_turn(&turn_id)
                .with_item(&item_id)
                .with_task(&task_id)
                .with_worker("w1")
                .with_stage("intake"),
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            Ok(json!({ "turnId": turn_id, "taskId": task_id, "status": "running" }))
        }
        "turn/interrupt" => {
            let thread = state.active_thread.lock().await.clone();
            let task_id = s("taskId");
            emit(
                state,
                SessionEvent::new(0, &thread, "turn.interrupted", "human", json!({
                    "taskId": task_id, "note": "老板叫停了这一轮"
                }))
                .with_task(&task_id),
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            Ok(json!({ "ok": true, "taskId": task_id }))
        }

        "control" => {
            let thread = state.active_thread.lock().await.clone();
            let mut p = serde_json::Map::new();
            p.insert("action".into(), json!(s("action")));
            p.insert("note".into(), json!(format!("JSON-RPC 介入 · {}", s("action"))));
            for k in ["workerId", "stageId"] {
                if params.get(k).is_some() {
                    p.insert(k.into(), params[k].clone());
                }
            }
            if let Some(v) = params.get("value") {
                p.insert("value".into(), v.clone());
            }
            let frame = emit(
                state,
                SessionEvent::new(0, &thread, "system.control", "human", Value::Object(p)),
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            Ok(json!({ "ok": true, "seq": frame.event.seq }))
        }

        "tools/list" => {
            let registry = ToolRegistry::builtin();
            let views = state.snapshot.lock().await.tools.clone();
            Ok(json!({
                "tools": registry.list(),
                "views": views,
                "modelTools": registry.as_model_tools(),
                "policy": { "approvalRequired": "shell.exec", "enforcedAt": "protocol" }
            }))
        }
        "tools/call" => {
            let name = s("name");
            let registry = ToolRegistry::builtin();
            let tool = match registry.get(&name).cloned() {
                Some(t) => t,
                None => return Err((ERR_INVALID_PARAMS, format!("unknown tool: {name}"))),
            };
            let thread = state.active_thread.lock().await.clone();
            let turn_id = state
                .store
                .lock()
                .await
                .turns()
                .iter()
                .rev()
                .find(|t| t.status == "running")
                .map(|t| t.id.clone())
                .unwrap_or_default();
            let task_id = s("taskId");
            let worker_id = if s("workerId").is_empty() {
                tool.stage_id.clone()
            } else {
                s("workerId")
            };
            let args = params
                .get("args")
                .cloned()
                .unwrap_or_else(|| sample_args(&name, "manual"));
            let item_id = format!("tool-{}", crate::session::short_id());

            let mut call = SessionEvent::new(
                0,
                &thread,
                "tool.call",
                &worker_id,
                json!({
                    "toolName": name.clone(), "label": tool.label.clone(),
                    "args": args.clone(), "permission": tool.permission,
                    "stageId": tool.stage_id, "kind": "toolCall",
                    "source": "tools/call"
                }),
            )
            .with_item(&item_id)
            .with_worker(&worker_id)
            .with_stage(&tool.stage_id);
            if !task_id.is_empty() {
                call = call.with_task(&task_id);
            }
            if !turn_id.is_empty() {
                call = call.with_turn(&turn_id);
            }
            let call_frame = emit(state, call)
                .await
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;

            // The capability seam lives here, not in the browser: an
            // approval-gated device is refused by the protocol layer itself.
            let (outcome, blocked) = if tool.permission == "approval" {
                (
                    ToolOutcome {
                        ok: false,
                        receipt: "需老板签字，设备未启动".into(),
                        duration_ms: 0,
                    },
                    true,
                )
            } else {
                (registry.execute(&name, &args), false)
            };
            let ok = outcome.ok;
            let receipt = outcome.receipt;
            let duration = outcome.duration_ms;

            let mut result = SessionEvent::new(
                0,
                &thread,
                "tool.result",
                &worker_id,
                json!({
                    "toolName": name.clone(), "label": tool.label.clone(),
                    "ok": ok, "receipt": receipt.clone(), "durationMs": duration,
                    "blocked": blocked
                }),
            )
            .with_item(&item_id)
            .with_worker(&worker_id)
            .with_stage(&tool.stage_id);
            if !task_id.is_empty() {
                result = result.with_task(&task_id);
            }
            if !turn_id.is_empty() {
                result = result.with_turn(&turn_id);
            }
            let result_frame = emit(state, result)
                .await
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;

            Ok(json!({
                "ok": ok,
                "blocked": blocked,
                "reason": if blocked { "approval" } else { "" },
                "toolName": name,
                "receipt": receipt,
                "callSeq": call_frame.event.seq,
                "resultSeq": result_frame.event.seq
            }))
        }

        "config/read" => Ok(serde_json::to_value(state.config.view()).unwrap()),
        "config/write" => {
            let view = state
                .config
                .update(params)
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            let thread = state.active_thread.lock().await.clone();
            let _ = emit(
                state,
                SessionEvent::new(0, &thread, "config.updated", "human", json!({
                    "model": view.model, "mode": view.mode
                })),
            )
            .await;
            Ok(serde_json::to_value(view).unwrap())
        }

        "session/replay" => {
            let thread = if s("threadId").is_empty() {
                state.active_thread.lock().await.clone()
            } else {
                s("threadId")
            };
            let after = params.get("afterSeq").and_then(Value::as_u64).unwrap_or(0);
            Ok(json!({ "frames": build_frames(state, &thread, after).await }))
        }

        "event/ingest" => {
            let thread = if s("threadId").is_empty() {
                "external".into()
            } else {
                s("threadId")
            };
            let kind = if s("kind").is_empty() { "external.event".into() } else { s("kind") };
            let actor = if s("actor").is_empty() { "external".into() } else { s("actor") };
            let payload = params.get("payload").cloned().unwrap_or_else(|| json!({}));
            let mut ev = SessionEvent::new(0, &thread, &kind, &actor, payload);
            if !s("stage").is_empty() {
                ev = ev.with_stage(&s("stage"));
            }
            if !s("taskId").is_empty() {
                ev = ev.with_task(&s("taskId"));
            }
            if !s("workerId").is_empty() {
                ev = ev.with_worker(&s("workerId"));
            }
            let frame = emit_external(state, ev)
                .await
                .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
            Ok(json!({ "ok": true, "seq": frame.event.seq }))
        }

        // Alternative approval path for clients that can't send raw responses.
        "approval/respond" => {
            let id = params.get("id").and_then(Value::as_u64).unwrap_or(0);
            if let Some(tx) = state.approvals.lock().await.remove(&id) {
                let _ = tx.send(ApprovalReply {
                    decision: s("decision"),
                    note: s("note"),
                });
                Ok(json!({ "ok": true }))
            } else {
                Err((ERR_INVALID_PARAMS, "no pending approval".into()))
            }
        }

        _ => Err((ERR_METHOD_NOT_FOUND, format!("unknown method: {method}"))),
    }
}

/// Rebuild the live projection from the log after switching threads.
async fn rebuild_snapshot(state: &Arc<AppState>, thread_id: &str) {
    let events = state.store.lock().await.events_for(thread_id, 0);
    let mut snap = initial_snapshot(thread_id);
    snap.threads = state.store.lock().await.threads();
    for ev in &events {
        project(&mut snap, ev);
    }
    snap.threads = state.store.lock().await.threads();
    snap.turns = state.store.lock().await.turns();
    snap.items = state.store.lock().await.items();
    snap.thread_id = thread_id.into();
    *state.snapshot.lock().await = snap;
    state.broadcast(RpcMessage::notification(
        "workshop/snapshot",
        json!({ "event": { "kind": "thread.resumed", "threadId": thread_id }, "snapshot": *state.snapshot.lock().await }),
    ));
}

// ---------------------------------------------------------------------------
// stdio transport (JSONL over stdin/stdout), like `codex app-server --stdio`
// ---------------------------------------------------------------------------

pub async fn run_stdio(state: Arc<AppState>) -> anyhow::Result<()> {
    use std::io::Write;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let mut sub = state.tx.subscribe();
    let printer = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(text) = out_rx.recv() => {
                    println!("{text}");
                    let _ = std::io::stdout().flush();
                }
                Ok(text) = sub.recv() => {
                    println!("{text}");
                    let _ = std::io::stdout().flush();
                }
                else => break,
            }
        }
    });

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Some(line) = lines.next_line().await? {
        handle_line(&state, &line, &out_tx).await;
    }
    printer.abort();
    Ok(())
}
