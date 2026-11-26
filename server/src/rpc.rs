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
use crate::observe::{CAMERAS, STRUCTURAL_BLINDSPOTS};
use crate::protocol::*;
use crate::session::SessionStore;
use crate::workshop::{emit, initial_snapshot, project};
use crate::tools::{sample_args, ToolRegistry};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
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
use std::collections::{HashMap, VecDeque};
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
    /// Submitted work orders waiting for the driver's next tick.
    pub orders: Mutex<VecDeque<WorkOrder>>,
    pub next_id: AtomicU64,
    pub llm_calls: AtomicU64,
    pub initialized: AtomicBool,
}

/// The criteria a work order may declare. The oracle only knows how to find
/// evidence for these ids, so the intake gate rejects anything else.
const CRITERIA: &[(&str, &str)] = &[
    ("conclusion", "有可交付结论"),
    ("source", "结论有来源支撑"),
    ("crosscheck", "做过交叉校验"),
    ("delivered", "产出交付件"),
    ("approved", "高风险动作已签字"),
];

/// One-click recipes at the order desk. `compliance` is the interesting one:
/// it makes the model reach for the approval-gated device, which suspends the
/// turn until the operator signs it.
const TEMPLATES: &[(&str, &str, &str, &[&str])] = &[
    ("draft", "生成结论草稿", "产出一份能直接交给下一环节的结论", &["conclusion"]),
    ("lookup", "检索内部知识", "检索并归纳内部知识", &["conclusion", "source"]),
    ("verify", "交叉验证数据", "两份数据交叉比对，标出差异", &["conclusion", "crosscheck"]),
    ("package", "整理交付件", "把结论整理成可交付的成品", &["conclusion", "delivered"]),
    ("synthesize", "汇总多方结论", "汇总多来源结论并交付", &["conclusion", "crosscheck", "delivered"]),
    ("compliance", "合规复核", "复核结论是否合规且可追溯", &["conclusion", "source", "approved"]),
];

fn criterion_label(id: &str) -> Option<&'static str> {
    CRITERIA.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}

fn template_json() -> Vec<Value> {
    TEMPLATES
        .iter()
        .map(|(id, title, goal, ids)| {
            json!({
                "id": id,
                "title": title,
                "goal": goal,
                "criteria": ids.iter().map(|c| json!({ "id": c, "label": criterion_label(c).unwrap_or(c) })).collect::<Vec<_>>()
            })
        })
        .collect()
}

fn criteria_json() -> Vec<Value> {
    CRITERIA
        .iter()
        .map(|(id, label)| json!({ "id": id, "label": label }))
        .collect()
}

/// Parse + validate one submitted order. Everything that enters the log is
/// declared here, up front — the oracle grades exactly this rubric.
fn parse_order(state: &Arc<AppState>, params: &Value, source: &str) -> Result<WorkOrder, String> {
    let text = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let template_id = text("template");
    let template = TEMPLATES.iter().find(|(id, _, _, _)| *id == template_id);
    let title = {
        let t = text("title");
        if !t.is_empty() {
            t
        } else if let Some((_, t, _, _)) = template {
            (*t).to_string()
        } else {
            "未命名工单".to_string()
        }
    };
    if title.chars().count() > 80 {
        return Err("工单标题最多 80 字".into());
    }

    let mut criteria: Vec<CriterionDecl> = Vec::new();
    if let Some(arr) = params.get("criteria").and_then(Value::as_array) {
        for c in arr {
            let id = c
                .as_str()
                .map(String::from)
                .or_else(|| c.get("id").and_then(Value::as_str).map(String::from))
                .unwrap_or_default();
            let Some(label) = criterion_label(&id) else {
                return Err(format!("未知判据 {id}；可用：{}", CRITERIA.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")));
            };
            if !criteria.iter().any(|x| x.id == id) {
                criteria.push(CriterionDecl { id, label: label.into() });
            }
        }
    } else if let Some((_, _, _, ids)) = template {
        for id in *ids {
            if let Some(label) = criterion_label(id) {
                criteria.push(CriterionDecl { id: (*id).into(), label: label.into() });
            }
        }
    }
    if criteria.is_empty() {
        let fallback = crate::oracle::goal_for(&title);
        criteria = fallback
            .criteria
            .iter()
            .map(|(id, label)| CriterionDecl { id: id.clone(), label: label.clone() })
            .collect();
    }

    let goal = {
        let g = text("goal");
        if !g.is_empty() {
            g
        } else if let Some((_, _, t, _)) = template {
            (*t).to_string()
        } else {
            crate::oracle::goal_for(&title).text
        }
    };
    let goal_id = if template_id.is_empty() {
        crate::oracle::goal_for(&title).id
    } else {
        template_id.clone()
    };
    let id = format!("M{:03}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let note = if source == "api" {
        "REST /api/orders 投料".to_string()
    } else {
        "3D 投单台投料".to_string()
    };
    Ok(WorkOrder {
        id,
        title,
        goal,
        goal_id,
        criteria,
        source: source.into(),
        note,
    })
}

async fn enqueue_order(state: &Arc<AppState>, params: Value, source: &str) -> Result<Value, String> {
    let order = parse_order(state, &params, source)?;
    let position = {
        let mut q = state.orders.lock().await;
        q.push_back(order.clone());
        q.len()
    };
    Ok(json!({
        "ok": true,
        "accepted": true,
        "taskId": order.id,
        "title": order.title,
        "goal": order.goal,
        "criteria": order.criteria,
        "queuePosition": position,
        "source": order.source,
        "note": "已排队，下一个节拍由派单台接收并进入 agent loop"
    }))
}

impl AppState {
    pub fn new(config: ConfigStore, store: SessionStore) -> Arc<Self> {
        let thread = store
            .threads()
            .first()
            .map(|t| t.id.clone())
            .unwrap_or_else(|| "main".into());
        // Work-order ids must survive a restart. Reusing M001 would collide
        // with the persisted log and make replay ambiguous.
        let next_order = store
            .all_events()
            .iter()
            .filter_map(|e| e.task_id.as_deref())
            .filter_map(|t| t.strip_prefix('M').and_then(|s| s.parse::<u64>().ok()))
            .max()
            .map(|n| n + 1)
            .unwrap_or(1);
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
            orders: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(next_order),
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
        .route("/api/context", get(context_read))
        .route("/api/observations", get(observations_read))
        .route("/api/models", get(models_read))
        .route("/api/orders", get(orders_read))
        .route("/api/orders", post(orders_create))
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
            "orders/templates", "control", "config/read", "config/write",
            "event/ingest", "session/replay", "session/context",
            "approval/respond", "tools/list", "tools/call",
            "camera/list", "camera/capture"
        ],
        "notifications": [
            "thread/started", "turn/started", "turn/completed", "turn/failed",
            "turn/interrupted",
            "item/started", "item/agentMessage/delta", "item/completed",
            "agent/iteration", "model/request", "model/response", "verdict",
            "boss/patrol", "boss/inspection", "boss/intervention",
            "dispatch/decision", "worker/assigned",
            "tool/call", "tool/result",
            "approval/granted", "approval/denied",
            "camera/capture", "camera/blindspot",
            "workshop/snapshot", "system/control", "config/updated", "session/event"
        ],
        "serverRequests": ["approval/request"],
        "sources": ["append-only JSONL session log"],
        "roles": { "boss": "decides + intervenes", "camera": "observes only" },
    }))
}

/// Replay: rebuild frames by projecting the log from the beginning. This is
/// the "state is a projection" guarantee — no separate stored truth.
/// Replay budget. Every frame embeds a full projection, so replaying a long
/// append-only log frame-by-frame turns into hundreds of MB over the wire.
/// The UI only keeps a sliding window, so the server sends the tail only.
/// How many replay frames `thread/resume` returns. Each frame carries a full
/// projection of the shop (stages, workers, tasks, tools, cameras), so this
/// number multiplies directly into the websocket payload. 240 frames plus the
/// raw event list used to ship ~44 MB, and the browser spent ten seconds
/// parsing it before the first paint. The timeline only needs recent history.
const MAX_REPLAY_FRAMES: usize = 64;

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

/// REST view of the observation ledger (a shim over camera/list).
async fn observations_read(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match dispatch(&state, "camera/list", json!({})).await {
        Ok(value) => Json(value),
        Err((_, message)) => Json(json!({ "error": message })),
    }
}

/// The agent loop's own ledger: what went out, what came back, how it ended.
/// This is a shim over the snapshot so a `curl` can verify the loop without a
/// WebSocket client.
async fn models_read(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let snap = state.snapshot.lock().await;
    let verdicts: Vec<Value> = snap
        .tasks
        .iter()
        .filter_map(|t| t.verdict.as_ref().map(|v| json!({
            "taskId": t.id,
            "passed": v.passed,
            "missing": v.missing,
            "note": v.note,
            "seq": v.seq
        })))
        .collect();
    Json(json!({
        "modelLog": snap.model_log,
        "verdicts": verdicts,
        "metrics": {
            "iterations": snap.metrics.iterations,
            "modelCalls": snap.metrics.llm_calls,
            "passed": snap.metrics.passed,
            "rejected": snap.metrics.rejected
        }
    }))
}

/// The order desk over plain HTTP, so `curl` is enough to play the workshop.
/// GET explains the contract; POST queues one work order.
async fn orders_read(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "howto": "POST /api/orders {\"title\": \"...\", \"goal\"?: \"...\", \"criteria\"?: [\"source\",\"approved\"], \"template\"?: \"compliance\"}",
        "templates": template_json(),
        "criteria": criteria_json(),
        "queued": state.orders.lock().await.len(),
        "autoDemo": state.config.get().auto_demo,
        "playing": state.snapshot.lock().await.playing,
        "example": "curl -s -X POST http://127.0.0.1:8787/api/orders -H \"Content-Type: application/json\" -d \"{\\\"template\\\":\\\"compliance\\\"}\""
    }))
}

async fn orders_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match enqueue_order(&state, body, "api").await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct ContextQuery {
    #[serde(default, rename = "taskId")]
    task_id: Option<String>,
}

/// Derive the model context for one work order (REST shim over session/context).
async fn context_read(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ContextQuery>,
) -> impl IntoResponse {
    match build_context(&state, q.task_id.as_deref()).await {
        Ok(ctx) => Json(serde_json::to_value(ctx).unwrap_or_else(|_| json!({}))),
        Err(message) => Json(json!({ "ok": false, "error": message })),
    }
}

/// Rebuild one work order's context from the append-only log. This is the
/// `deriveMessages` step: no stored prompt, only facts.
async fn build_context(
    state: &Arc<AppState>,
    task_id: Option<&str>,
) -> Result<DerivedContext, String> {
    let task = match task_id {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => state
            .store
            .lock()
            .await
            .latest_task_id()
            .ok_or_else(|| "该线程还没有工单".to_string())?,
    };
    let events = state.store.lock().await.task_events(&task);
    if events.is_empty() {
        return Err(format!("找不到工单 {task} 的日志"));
    }
    Ok(crate::context::derive(&events, &task, &state.config.get()))
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
    let (_stored, frame) = {
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
                    "toolCall": true,
                    "dispatch": true,
                    "context": "deriveMessages",
                    "observe": true,
                    "camera": "readOnly",
                    "agentLoop": true,
                    "agentLoopMaxIterations": 4,
                    "modelLog": true,
                    "verdict": "oracle",
                    "orderQueue": true,
                    "customCriteria": true,
                    "toolApproval": true
                },
                "configHome": state.config.home.display().to_string(),
                "config": state.config.view(),
                "activeThread": state.active_thread.lock().await.clone(),
                // Ship the order desk with the handshake so the first paint
                // already has the rubric — no extra round trip, no blank desk.
                "templates": template_json(),
                "criteria": criteria_json(),
                "autoDemo": state.config.get().auto_demo
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
                // `events` is deliberately not shipped here: the UI replays
                // from `frames`, and returning every historical event made the
                // resume payload tens of megabytes.
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

        // A turn is not emitted by the caller. It is queued, then opened by
        // the runtime driver on its next tick. That is what guarantees a
        // human order, a REST order and a demo order all travel the same
        // path: dispatcher -> agent loop -> oracle -> verdict.
        "turn/start" => enqueue_order(state, params, "human")
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e)),

        "orders/templates" => Ok(json!({
            "templates": template_json(),
            "criteria": criteria_json(),
            "queued": state.orders.lock().await.len(),
            "autoDemo": state.config.get().auto_demo,
            "playing": state.snapshot.lock().await.playing
        })),
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

            // The capability seam lives here, not in the browser: a risky
            // device is never started without a signature, whether the model
            // asked for it or a human pressed the button in the equipment tab.
            let (ok, receipt, duration, blocked) = if tool.permission == "approval" {
                let signed = crate::workshop::request_tool_approval(
                    state,
                    &thread,
                    &turn_id,
                    &task_id,
                    &worker_id,
                    &tool.stage_id,
                    &name,
                    &tool.label,
                    &item_id,
                    &args,
                )
                .await;
                if signed {
                    let o = registry.execute(&name, &args);
                    (
                        o.ok,
                        format!("老板签字后执行 · {}", o.receipt),
                        o.duration_ms,
                        false,
                    )
                } else {
                    (false, "老板未签字，设备未启动".to_string(), 0, true)
                }
            } else {
                let o = registry.execute(&name, &args);
                (o.ok, o.receipt, o.duration_ms, false)
            };

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

        // deriveMessages: rebuild one work order's context from the log.
        "session/context" => {
            let requested = s("taskId");
            let ctx = build_context(
                state,
                if requested.is_empty() { None } else { Some(requested.as_str()) },
            )
            .await
            .map_err(|e| (ERR_INVALID_PARAMS, e))?;
            Ok(serde_json::to_value(ctx).unwrap())
        }

        // Cameras are read-only observers. `camera/list` describes the role
        // and the blind spots it can see but never fix.
        "camera/list" => {
            let snap = state.snapshot.lock().await.clone();
            let cameras: Vec<Value> = CAMERAS
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id, "label": c.label, "focus": c.focus,
                        "position": { "x": c.x, "y": c.y, "z": c.z }
                    })
                })
                .collect();
            let structural: Vec<Value> = STRUCTURAL_BLINDSPOTS
                .iter()
                .map(|(code, note)| json!({ "code": code, "note": note }))
                .collect();
            Ok(json!({
                "cameras": cameras,
                "views": snap.cameras,
                "observations": snap.observations,
                "structuralBlindspots": structural,
                "observability": snap.metrics.observability,
                "counts": {
                    "captures": snap.metrics.captures,
                    "blindspots": snap.metrics.blindspots
                },
                "policy": {
                    "readOnly": true,
                    "canDecide": false,
                    "canIntervene": false,
                    "writesFacts": ["camera.capture", "camera.blindspot"],
                    "note": "摄像头只往 append-only 日志写观测事实，不派单、不介入、不改任何工单状态。"
                }
            }))
        }
        "camera/capture" => {
            let requested = s("cameraId");
            let cam = CAMERAS
                .iter()
                .find(|c| c.id == requested)
                .unwrap_or(&CAMERAS[0]);
            let thread = state.active_thread.lock().await.clone();
            let events = state.store.lock().await.recent_events(400);
            let mode = state.config.get().mode;
            let tick = state.snapshot.lock().await.tick;
            let cap = crate::observe::capture(&events, tick, &mode);
            let mut seqs = Vec::new();
            for ev in crate::workshop::observation_events(&thread, cam, &cap, tick) {
                let frame = emit(state, ev)
                    .await
                    .map_err(|e| (ERR_INVALID_PARAMS, e.to_string()))?;
                seqs.push(frame.event.seq);
            }
            Ok(json!({
                "cameraId": cam.id,
                "seen": cap.seen,
                "checks": cap.checks,
                "gaps": cap.gaps,
                "coverage": cap.coverage,
                "blindspots": cap.blindspots.len(),
                "codes": cap.blindspots.iter().map(|b| b.code).collect::<Vec<_>>(),
                "seqs": seqs,
                "readOnly": true,
                "note": cap.note
            }))
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
