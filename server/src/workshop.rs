//! The workshop runtime. It hosts the agent loop (work orders flowing through
//! stations), emits UI-ready JSON-RPC notifications, and owns the boss's
//! patrol / inspection / approval behaviour. State is a projection of the
//! append-only session log.

use crate::config::ConfigStore;
use crate::llm::{complete_blocking, mock_text, LlmClient};
use crate::protocol::*;
use crate::rpc::{AppState, ApprovalReply};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

const STAGES: [(&str, &str, f64, &str); 3] = [
    ("intake", "工位 A · 检索", -5.0, "#185fa5"),
    ("analysis", "工位 B · 分析", 0.0, "#534ab7"),
    ("review", "工位 C · 质检", 5.0, "#1d9e75"),
];

const WORKERS: [(&str, &str, &str, &str); 3] = [
    ("w1", "检索员", "intake", "provider-a"),
    ("w2", "分析员", "analysis", "provider-b"),
    ("w3", "质检员", "review", "provider-c"),
];

const TASK_TITLES: &[&str] = &[
    "解析需求文档", "检索内部知识", "交叉验证数据", "生成结论草稿",
    "合规复核", "整理交付件", "校对引用来源", "汇总多方结论",
];

pub fn initial_snapshot(thread_id: &str) -> Snapshot {
    Snapshot {
        run_id: "medusa-shift-001".into(),
        thread_id: thread_id.into(),
        playing: true,
        speed: 1.0,
        stages: STAGES
            .iter()
            .map(|(id, name, x, color)| Stage {
                id: (*id).into(),
                name: (*name).into(),
                position: Vec3 { x: *x, y: 0.0, z: 0.0 },
                color: (*color).into(),
            })
            .collect(),
        workers: WORKERS
            .iter()
            .map(|(id, name, stage, cfg)| Worker {
                id: (*id).into(),
                name: (*name).into(),
                model: String::new(),
                stage_id: (*stage).into(),
                status: "idle".into(),
                load: 0.0,
                tokens: 0,
                task_id: None,
                config_id: Some((*cfg).into()),
            })
            .collect(),
        tasks: Vec::new(),
        boss: Boss {
            x: -6.0,
            z: 5.2,
            target_stage_id: String::new(),
            mode: "patrol".into(),
            note: "开始巡逻".into(),
        },
        metrics: Metrics::default(),
        threads: Vec::new(),
        turns: Vec::new(),
        items: Vec::new(),
        last_event: None,
        ..Default::default()
    }
}

/// Apply one logged fact to the derived projection.
pub fn project(snap: &mut Snapshot, ev: &SessionEvent) {
    let p = &ev.payload;
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let u = |k: &str| p.get(k).and_then(Value::as_u64).unwrap_or(0);

    snap.last_event = Some(ev.clone());
    snap.seq = ev.seq;

    match ev.kind.as_str() {
        "turn.started" => {
            let id = s("taskId");
            snap.tasks.push(WorkTask {
                id: id.clone(),
                title: s("title"),
                stage_index: 0,
                progress: 0.0,
                status: "running".into(),
            });
        }
        "item.started" => {
            let wid = ev.worker_id.clone().unwrap_or_default();
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.status = "busy".into();
                w.load = 0.65;
                w.task_id = ev.task_id.clone();
            }
        }
        "item.agentMessage.delta" => {
            let wid = ev.worker_id.clone().unwrap_or_default();
            let tokens = u("tokens");
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.tokens += tokens;
            }
            snap.metrics.tokens += tokens;
            if let Some(task) = snap
                .tasks
                .iter_mut()
                .find(|t| Some(&t.id) == ev.task_id.as_ref())
            {
                task.progress = (task.progress + 0.16).min(0.96);
            }
        }
        "item.completed" => {
            let wid = ev.worker_id.clone().unwrap_or_default();
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.status = "idle".into();
                w.load = 0.0;
                w.task_id = None;
            }
        }
        "task.moved" => {
            if let Some(task) = snap
                .tasks
                .iter_mut()
                .find(|t| Some(&t.id) == ev.task_id.as_ref())
            {
                task.stage_index = n("stageIndex") as i32;
                task.progress = n("progress");
            }
        }
        "task.completed" | "turn.completed" => {
            if let Some(task) = snap
                .tasks
                .iter_mut()
                .find(|t| Some(&t.id) == ev.task_id.as_ref())
            {
                task.status = "done".into();
                task.progress = 1.0;
            }
            snap.metrics.completed += 1;
        }
        "task.failed" | "turn.interrupted" => {
            if let Some(task) = snap
                .tasks
                .iter_mut()
                .find(|t| Some(&t.id) == ev.task_id.as_ref())
            {
                task.status = "failed".into();
            }
            snap.metrics.failed += 1;
        }
        "worker.blocked" => {
            let wid = ev.worker_id.clone().unwrap_or_default();
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.status = "blocked".into();
            }
        }
        "worker.resumed" => {
            let wid = ev.worker_id.clone().unwrap_or_default();
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.status = "busy".into();
            }
        }
        "boss.patrol" => {
            snap.boss.x = n("x");
            snap.boss.z = n("z");
            snap.boss.mode = "patrol".into();
            snap.boss.target_stage_id.clear();
            snap.boss.note = s("note");
        }
        "boss.inspection" => {
            snap.boss.x = n("x");
            snap.boss.mode = "inspect".into();
            snap.boss.target_stage_id = s("stageId");
            snap.boss.note = s("note");
        }
        "boss.intervention" => {
            snap.boss.mode = "intervene".into();
            snap.boss.target_stage_id = s("stageId");
            snap.boss.note = s("note");
            apply_control(snap, p);
        }
        "system.control" => apply_control(snap, p),
        "config.updated" => {
            let model = s("model");
            for w in &mut snap.workers {
                w.model = model.clone();
            }
        }
        _ => {}
    }
    recompute(snap);
}

fn apply_control(snap: &mut Snapshot, p: &Value) {
    let action = p.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "pause" => snap.playing = false,
        "resume" => snap.playing = true,
        "stop" => {
            snap.playing = false;
            for w in &mut snap.workers {
                w.status = "paused".into();
            }
        }
        "speed" => {
            let v = p.get("value").and_then(Value::as_f64).unwrap_or(1.0);
            if v > 0.0 {
                snap.speed = v;
            }
        }
        "reassign" => {
            let wid = p.get("workerId").and_then(Value::as_str).unwrap_or("");
            let sid = p.get("stageId").and_then(Value::as_str).unwrap_or("");
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                if !sid.is_empty() {
                    w.stage_id = sid.into();
                }
            }
        }
        _ => {}
    }
}

fn recompute(snap: &mut Snapshot) {
    let mut active = 0;
    let mut blocked = 0;
    for w in &snap.workers {
        if w.status == "busy" {
            active += 1;
        }
        if w.status == "blocked" {
            blocked += 1;
        }
    }
    snap.metrics.active_workers = active;
    snap.metrics.blocked = blocked;
    snap.metrics.cost = snap.metrics.tokens as f64 * 0.000002;
    if snap.tick > 0 {
        snap.metrics.throughput = snap.metrics.completed as f64
            / (snap.tick as f64 * 0.42 / 60.0).max(0.01);
    }
}

/// A single tick's worth of work, expressed as session-log facts plus an
/// optional server-initiated approval request.
pub struct TickPlan {
    pub events: Vec<SessionEvent>,
    pub approval: Option<ApprovalPlan>,
}

pub struct ApprovalPlan {
    pub stage: String,
    pub note: String,
    pub task_id: String,
    pub turn_id: String,
}

pub fn plan_tick(snap: &Snapshot, tick: u64, counter: &mut u64, seed: &mut u64) -> TickPlan {
    let mut events = Vec::new();
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let rnd = || -> f64 { ((*seed >> 33) as f64) / (u32::MAX as f64) };

    let thread_id = snap.thread_id.clone();
    let bx = -6.0 + 12.0 * (0.5 + 0.5 * (tick as f64 * 0.11).sin());

    if tick % 3 == 0 {
        events.push(
            SessionEvent::new(0, &thread_id, "boss.patrol", "boss", json!({
                "x": bx, "z": 5.2, "note": "沿流水线巡视"
            })),
        );
    }
    let mut approval = None;
    for (i, (sid, _name, sx, _color)) in STAGES.iter().enumerate() {
        if (bx - sx).abs() < 0.9 && tick % 3 == 0 {
            events.push(
                SessionEvent::new(0, &thread_id, "boss.inspection", "boss", json!({
                    "x": bx, "stageId": sid, "note": format!("抽查 {} 的产出", sid)
                }))
                .with_stage(sid),
            );
            // Roughly one in nine inspections escalates to a human gate.
            if rnd() < 0.11 {
                approval = Some(ApprovalPlan {
                    stage: (*sid).into(),
                    note: format!("老板在 {} 抽查到疑点，需要放行或叫停", sid),
                    task_id: snap
                        .tasks
                        .iter()
                        .rev()
                        .find(|t| t.status == "running")
                        .map(|t| t.id.clone())
                        .unwrap_or_default(),
                    turn_id: String::new(),
                });
            }
        }
        let _ = i;
    }

    let active: Vec<WorkTask> = snap
        .tasks
        .iter()
        .filter(|t| t.status == "running" || t.status == "queued")
        .cloned()
        .collect();

    if tick % 5 == 0 && active.len() < 5 {
        *counter += 1;
        let task_id = format!("T{:03}", counter);
        let turn_id = format!("turn-{}", crate::session::short_id());
        let title = TASK_TITLES[(*seed as usize) % TASK_TITLES.len()];
        events.push(
            SessionEvent::new(0, &thread_id, "turn.started", "system", json!({
                "taskId": task_id, "title": title
            }))
            .with_turn(&turn_id)
            .with_task(&task_id),
        );
        events.push(
            SessionEvent::new(0, &thread_id, "item.started", "w1", json!({
                "kind": "agentMessage", "stageId": "intake"
            }))
            .with_turn(&turn_id)
            .with_item(&format!("item-{}-{}", task_id, crate::session::short_id()))
            .with_task(&task_id)
            .with_worker("w1")
            .with_stage("intake"),
        );
        if let Some(a) = approval.as_mut() {
            a.turn_id = turn_id;
        }
    }

    for task in &active {
        let progress = task.progress + 0.12 + rnd() * 0.18;
        let index = task.stage_index;
        if progress >= 1.0 {
            if index + 1 >= STAGES.len() as i32 {
                events.push(
                    SessionEvent::new(0, &thread_id, "turn.completed", "w3", json!({
                        "taskId": task.id, "workerId": "w3"
                    }))
                    .with_task(&task.id)
                    .with_worker("w3")
                    .with_stage("review"),
                );
                continue;
            }
            let next = (index + 1) as usize;
            let (sid, _n, _x, _c) = STAGES[next];
            let wid = WORKERS[next].0;
            events.push(
                SessionEvent::new(0, &thread_id, "item.started", wid, json!({
                    "kind": "agentMessage", "stageId": sid
                }))
                .with_item(&format!("item-{}-{}", task.id, crate::session::short_id()))
                .with_task(&task.id)
                .with_worker(wid)
                .with_stage(sid),
            );
            events.push(
                SessionEvent::new(0, &thread_id, "task.moved", wid, json!({
                    "stageIndex": next, "progress": 0.0
                }))
                .with_task(&task.id)
                .with_worker(wid)
                .with_stage(sid),
            );
        } else {
            let slot = (index as usize).min(STAGES.len() - 1);
            let (sid, _n, _x, _c) = STAGES[slot];
            let wid = WORKERS[slot].0;
            events.push(
                SessionEvent::new(0, &thread_id, "task.moved", wid, json!({
                    "stageIndex": index, "progress": progress
                }))
                .with_task(&task.id)
                .with_worker(wid)
                .with_stage(sid),
            );
        }
    }

    if rnd() < 0.025 {
        let wid = WORKERS[(*seed as usize) % WORKERS.len()].0;
        events.push(
            SessionEvent::new(0, &thread_id, "worker.blocked", wid, json!({
                "note": "等待人工确认"
            }))
            .with_worker(wid),
        );
    }
    if rnd() < 0.06 {
        let wid = WORKERS[(*seed as usize) % WORKERS.len()].0;
        events.push(
            SessionEvent::new(0, &thread_id, "worker.resumed", wid, json!({
                "note": "恢复工作"
            }))
            .with_worker(wid),
        );
    }

    TickPlan { events, approval }
}

/// Emit a batch of facts: append to the log, project, then broadcast both the
/// fine-grained UI notification and the replayable frame.
pub async fn emit(state: &Arc<AppState>, ev: SessionEvent) -> anyhow::Result<Frame> {
    let (stored, frame) = {
        let mut store = state.store.lock().await;
        let stored = store.append(ev)?;
        let mut snap = state.snapshot.lock().await;
        project(&mut snap, &stored);
        snap.threads = store.threads();
        snap.turns = store.turns();
        snap.items = store.items();
        snap.thread_id = state.active_thread.lock().await.clone();
        (stored.clone(), Frame { event: stored, snapshot: snap.clone() })
    };

    let method = ui_method(&frame.event.kind);
    state.broadcast(RpcMessage::notification(
        method,
        serde_json::to_value(&frame.event)?,
    ));
    state.broadcast(RpcMessage::notification(
        "workshop/snapshot",
        serde_json::to_value(&frame)?,
    ));
    Ok(frame)
}

fn ui_method(kind: &str) -> &'static str {
    match kind {
        "thread.started" => "thread/started",
        "turn.started" => "turn/started",
        "turn.completed" => "turn/completed",
        "turn.interrupted" => "turn/interrupted",
        "item.started" => "item/started",
        "item.agentMessage.delta" => "item/agentMessage/delta",
        "item.completed" => "item/completed",
        "boss.patrol" => "boss/patrol",
        "boss.inspection" => "boss/inspection",
        "boss.intervention" => "boss/intervention",
        "system.control" => "system/control",
        "config.updated" => "config/updated",
        _ => "session/event",
    }
}

/// The driver task: one tick -> one batch of facts -> one possible approval
/// gate. An approval suspends the turn until the UI replies (Codex's
/// server-initiated request pattern).
pub async fn run_driver(state: Arc<AppState>) {
    let mut tick: u64 = 0;
    let mut counter: u64 = 0;
    let mut seed: u64 = 20261120;
    let llm = LlmClient::new();

    let _ = emit(
        &state,
        SessionEvent::new(0, "main", "run.started", "system", json!({
            "note": "班次开始，老板进场（app server 已接管运行时）"
        })),
    )
    .await;

    loop {
        let tick_ms = {
            let snap = state.snapshot.lock().await;
            let base = state.config.get().tick_ms.max(80);
            let speed = snap.speed.max(0.1);
            let playing = snap.playing;
            if !playing {
                tokio::time::sleep(Duration::from_millis(120)).await;
                continue;
            }
            (base as f64 / speed) as u64
        };
        tokio::time::sleep(Duration::from_millis(tick_ms)).await;

        let plan = {
            let mut snap = state.snapshot.lock().await;
            snap.tick += 1;
            tick += 1;
            plan_tick(&snap, tick, &mut counter, &mut seed)
        };

        for ev in plan.events {
            // Once a turn starts, stream its item's content as deltas.
            if ev.kind == "item.started" {
                let item_id = ev.item_id.clone().unwrap_or_default();
                let task_id = ev.task_id.clone().unwrap_or_default();
                let worker_id = ev.worker_id.clone().unwrap_or_default();
                let stage = ev.stage.clone();
                let turn_id = ev.turn_id.clone().unwrap_or_default();
                let thread_id = {
                    let snap = state.snapshot.lock().await;
                    snap.thread_id.clone()
                };
                if let Err(e) = emit(&state, ev).await {
                    eprintln!("emit failed: {e}");
                    continue;
                }
                stream_item(
                    &state,
                    &llm,
                    &thread_id,
                    &turn_id,
                    &item_id,
                    &task_id,
                    &worker_id,
                    &stage,
                    tick,
                )
                .await;
            } else if let Err(e) = emit(&state, ev).await {
                eprintln!("emit failed: {e}");
            }
        }

        if let Some(plan) = plan.approval {
            if let Err(e) = request_approval(&state, plan).await {
                eprintln!("approval failed: {e}");
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_item(
    state: &Arc<AppState>,
    llm: &LlmClient,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    task_id: &str,
    worker_id: &str,
    stage: &str,
    seed: u64,
) {
    let (provider, key, live) = {
        let cfg = &state.config;
        (
            cfg.active_provider(),
            cfg.api_key(),
            cfg.is_live(),
        )
    };

    let text = if live {
        let Some(p) = provider else { return };
        let Some(k) = key else { return };
        let cfg_snapshot = state.config.get();
        let system = format!(
            "你是 Medusa 流水线 {} 工位的 LLM 工人。只输出这一工位的工作结论，简短、具体，不超过 80 字。",
            stage
        );
        let user = format!("工单 {}：请完成 {} 工位的工作。", task_id, stage);
        let p2 = p.clone();
        let k2 = k.clone();
        let max_tokens = cfg_snapshot.max_tokens_per_turn;
        let _ = max_tokens;
        // Own the budget counters so the closure satisfies 'static.
        let llm2: LlmClient = Clone::clone(llm);
        match tokio::task::spawn_blocking(move || {
            // ConfigStore isn't Clone, so re-read from the same home for the
            // one value the blocking call needs.
            let home = crate::config::resolve_home();
            let store = crate::config::ConfigStore::load(home).ok();
            match store {
                Some(s) => complete_blocking(&s, &llm2, &p2, &k2, &system, &user),
                None => Err(anyhow::anyhow!("配置不可用")),
            }
        })
        .await
        {
            Ok(Ok(r)) => {
                state
                    .llm_calls
                    .fetch_add(1, Ordering::Relaxed);
                format!("[live · {} ms] {}", r.latency_ms, r.text)
            }
            Ok(Err(e)) => format!("[模型调用被闸口拦下] {}", e),
            Err(e) => format!("[模型调用异常] {}", e),
        }
    } else {
        mock_text(stage, task_id, seed)
    };

    let chunks: Vec<String> = text
        .chars()
        .collect::<Vec<char>>()
        .chunks(14)
        .map(|c| c.iter().collect())
        .collect();
    let per_chunk_tokens = 6u64;
    for chunk in &chunks {
        let mut ev = SessionEvent::new(
            0,
            thread_id,
            "item.agentMessage.delta",
            worker_id,
            json!({ "delta": chunk, "tokens": per_chunk_tokens }),
        )
        .with_item(item_id)
        .with_task(task_id)
        .with_worker(worker_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            ev = ev.with_turn(turn_id);
        }
        if let Err(e) = emit(state, ev).await {
            eprintln!("delta failed: {e}");
        }
        if live {
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }
    let mut done = SessionEvent::new(0, thread_id, "item.completed", worker_id, json!({
        "kind": "agentMessage", "tokens": 0
    }))
    .with_item(item_id)
    .with_task(task_id)
    .with_worker(worker_id)
    .with_stage(stage);
    if !turn_id.is_empty() {
        done = done.with_turn(turn_id);
    }
    if let Err(e) = emit(state, done).await {
        eprintln!("item.completed failed: {e}");
    }
}

async fn request_approval(state: &Arc<AppState>, plan: ApprovalPlan) -> anyhow::Result<()> {
    let id = state.next_request_id();
    let (tx, rx) = oneshot::channel::<ApprovalReply>();
    state
        .approvals
        .lock()
        .await
        .insert(id, tx);

    state.broadcast(RpcMessage::request(
        Value::from(id),
        "approval/request",
        json!({
            "stage": plan.stage,
            "note": plan.note,
            "taskId": plan.task_id,
            "turnId": plan.turn_id,
            "options": ["allow", "deny"]
        }),
    ));

    // Pause the turn until the UI answers; auto-allow after a bounded wait so
    // an unattended workshop never wedges.
    let reply = match tokio::time::timeout(Duration::from_secs(20), rx).await {
        Ok(Ok(r)) => r,
        _ => ApprovalReply {
            decision: "allow".into(),
            note: "超时自动放行".into(),
        },
    };

    let thread_id = state.active_thread.lock().await.clone();
    let payload = json!({
        "action": if reply.decision == "deny" { "stop" } else { "resume" },
        "stageId": plan.stage,
        "note": format!("审批 {} · {}", reply.decision, reply.note)
    });
    emit(
        state,
        SessionEvent::new(0, &thread_id, "boss.intervention", "boss", payload)
            .with_stage(&plan.stage)
            .with_task(&plan.task_id)
            .with_turn(&plan.turn_id),
    )
    .await?;
    Ok(())
}
