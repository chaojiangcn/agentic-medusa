//! The workshop runtime. It hosts the agent loop (work orders flowing through
//! stations), emits UI-ready JSON-RPC notifications, and owns the boss's
//! patrol / inspection / approval behaviour. State is a projection of the
//! append-only session log.

use crate::agent::{self, AgentReply};
use crate::dispatch::{decide, Decision};
use crate::llm::{complete_messages_blocking, LlmClient};
use crate::observe::{self, CameraSpec, CAMERAS};
use crate::oracle;
use crate::protocol::*;
use crate::rpc::{AppState, ApprovalReply};
use crate::tools::ToolRegistry;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

const STAGES: [(&str, &str, f64, &str); 3] = [
    ("intake", "工位 A · 检索", -5.0, "#185fa5"),
    ("analysis", "工位 B · 分析", 0.0, "#534ab7"),
    ("review", "工位 C · 质检", 5.0, "#1d9e75"),
];

// Four workers for three stations: `w4` is the floater the dispatcher pulls
// into a station when its regular is busy or blocked. That is the whole point
// of a dispatcher — otherwise the assignment is just a constant.
const WORKERS: [(&str, &str, &str, &str); 4] = [
    ("w1", "检索员", "intake", "provider-a"),
    ("w2", "分析员", "analysis", "provider-b"),
    ("w3", "质检员", "review", "provider-c"),
    ("w4", "机动员", "review", "provider-c"),
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
        tools: ToolRegistry::builtin()
            .list()
            .into_iter()
            .map(|t| ToolView {
                name: t.name,
                label: t.label,
                description: t.description,
                stage_id: t.stage_id,
                permission: t.permission,
                ..Default::default()
            })
            .collect(),
        cameras: CAMERAS
            .iter()
            .map(|c| CameraView {
                id: c.id.into(),
                label: c.label.into(),
                focus: c.focus.into(),
                position: Vec3 { x: c.x, y: c.y, z: c.z },
                status: "recording".into(),
                last_note: "待命中，尚未抓拍".into(),
                ..Default::default()
            })
            .collect(),
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
    let seqs = |k: &str| -> Vec<u64> {
        p.get(k)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default()
    };

    snap.last_event = Some(ev.clone());
    snap.seq = ev.seq;

    match ev.kind.as_str() {
        "turn.started" => {
            let id = s("taskId");
            let title = s("title");
            let goal = s("goal");
            let goal_id = s("goalId");
            let criteria = parse_criteria(p.get("criteria"));
            // A resumed or forked log can replay `turn.started` for a task
            // that is already on the shop floor; update it in place instead
            // of pushing a duplicate (React keys + 3D instances would double).
            if let Some(task) = snap.tasks.iter_mut().find(|task| task.id == id) {
                task.title = title;
                task.goal = goal;
                task.goal_id = goal_id;
                task.criteria = criteria;
                task.verdict = None;
                task.iterations = 0;
                task.stage_index = 0;
                task.progress = 0.0;
                task.status = "running".into();
            } else {
                snap.tasks.push(WorkTask {
                    id: id.clone(),
                    title,
                    goal,
                    goal_id,
                    criteria,
                    stage_index: 0,
                    progress: 0.0,
                    status: "running".into(),
                    iterations: 0,
                    verdict: None,
                });
            }
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
            // A closed agentMessage is the evidence the conclusion criterion
            // asks for, so the ledger lights up as the work happens rather
            // than only at the verdict.
            let kind = s("kind");
            if kind.is_empty() || kind == "agentMessage" {
                if let Some(task) = snap
                    .tasks
                    .iter_mut()
                    .find(|t| Some(&t.id) == ev.task_id.as_ref())
                {
                    if let Some(c) = task.criteria.iter_mut().find(|c| c.id == "conclusion") {
                        c.ok = true;
                        c.note = "工件闭合，可交给下一环节".into();
                        c.evidence_seq = ev.seq;
                    }
                }
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
        "tool.call" => {
            let name = s("toolName");
            for t in &mut snap.tools {
                t.active = false;
            }
            if let Some(t) = snap.tools.iter_mut().find(|t| t.name == name) {
                t.calls += 1;
                t.active = true;
                t.last_seq = ev.seq;
                t.last_receipt = format!("{} 启动中…", t.label);
            }
        }
        "tool.result" => {
            let name = s("toolName");
            if let Some(t) = snap.tools.iter_mut().find(|t| t.name == name) {
                t.active = false;
                t.last_seq = ev.seq;
                t.last_receipt = s("receipt");
            }
            // A receipt is evidence. A blocked device produces none, which is
            // exactly why a refused shell call must not light up "approved".
            let ok = p.get("ok").and_then(Value::as_bool).unwrap_or(true);
            if ok {
                if let Some(cid) = criterion_for_tool(&name) {
                    if let Some(task) = snap
                        .tasks
                        .iter_mut()
                        .find(|t| Some(&t.id) == ev.task_id.as_ref())
                    {
                        if let Some(c) = task.criteria.iter_mut().find(|c| c.id == cid) {
                            c.ok = true;
                            c.note = "有设备小票佐证".into();
                            c.evidence_seq = ev.seq;
                        }
                    }
                }
            }
        }
        // A signature is a fact, so the ledger lights up the moment the boss
        // signs — not only when the final verdict is computed.
        "approval.granted" | "approval.denied" => {
            let granted = ev.kind == "approval.granted";
            let tool_name = s("toolName");
            snap.boss.mode = "inspect".into();
            snap.boss.note = format!(
                "{} {}",
                if granted { "签字放行" } else { "驳回" },
                tool_name
            );
            if granted {
                if let Some(task) = snap
                    .tasks
                    .iter_mut()
                    .find(|t| Some(&t.id) == ev.task_id.as_ref())
                {
                    if let Some(c) = task.criteria.iter_mut().find(|c| c.id == "approved") {
                        c.ok = true;
                        c.note = "老板已签字".into();
                        c.evidence_seq = ev.seq;
                    }
                }
            }
        }
        "dispatch.decision" => {
            let record = DispatchRecord {
                task_id: s("taskId"),
                turn_id: ev.turn_id.clone().unwrap_or_default(),
                stage_id: s("stageId"),
                worker_id: s("workerId"),
                worker_name: s("workerName"),
                score: n("score"),
                reason: s("reason"),
                alternatives: s("alternatives"),
                seq: ev.seq,
            };
            let stage_id = record.stage_id.clone();
            let task_id = record.task_id.clone();
            snap.dispatch.push(record);
            if snap.dispatch.len() > 6 {
                snap.dispatch.remove(0);
            }
            snap.metrics.dispatched += 1;
            // The boss is the one assigning work, so it walks to the station —
            // standing to the side, not on top of the worker it just assigned.
            if let Some(stage) = STAGES.iter().find(|(id, _, _, _)| *id == stage_id.as_str()) {
                snap.boss.x = stage.2 + 2.6;
                snap.boss.z = 2.8;
                snap.boss.mode = "dispatch".into();
                snap.boss.target_stage_id = stage_id.clone();
                snap.boss.note = format!("派遣 {}", task_id);
            }
        }
        "worker.assigned" => {
            let wid = s("workerId");
            let sid = s("stageId");
            if let Some(w) = snap.workers.iter_mut().find(|w| w.id == wid) {
                w.stage_id = sid;
            }
        }
        // Observation facts only touch the camera ledger. A camera must never
        // change a task, worker, device or the boss — read-only by construction.
        "camera.capture" => {
            let cid = s("cameraId");
            let note = s("note");
            let coverage = n("coverage");
            if let Some(cam) = snap.cameras.iter_mut().find(|c| c.id == cid) {
                cam.captures += 1;
                cam.last_seq = ev.seq;
                cam.last_note = note.clone();
                cam.status = if u("blindspots") > 0 {
                    "alert".into()
                } else {
                    "recording".into()
                };
            }
            snap.metrics.captures += 1;
            snap.metrics.observability = coverage;
            snap.observations.push(ObservationRecord {
                seq: ev.seq,
                tick: u("tick"),
                camera_id: cid.clone(),
                camera_label: s("cameraLabel"),
                kind: "capture".into(),
                code: "clear".into(),
                subject: s("focus"),
                note,
                coverage,
                evidence_seqs: seqs("evidenceSeqs"),
            });
            trim_observations(snap);
        }
        "camera.blindspot" => {
            let cid = s("cameraId");
            let note = s("note");
            if let Some(cam) = snap.cameras.iter_mut().find(|c| c.id == cid) {
                cam.blindspots += 1;
                cam.last_seq = ev.seq;
                cam.last_note = note.clone();
                cam.status = "alert".into();
            }
            snap.metrics.blindspots += 1;
            snap.metrics.observability = n("coverage");
            snap.observations.push(ObservationRecord {
                seq: ev.seq,
                tick: u("tick"),
                camera_id: cid.clone(),
                camera_label: s("cameraLabel"),
                kind: "blindspot".into(),
                code: s("code"),
                subject: s("subject"),
                note,
                coverage: n("coverage"),
                evidence_seqs: seqs("evidenceSeqs"),
            });
            trim_observations(snap);
        }
        "agent.iteration" => {
            if let Some(task) = snap
                .tasks
                .iter_mut()
                .find(|t| Some(&t.id) == ev.task_id.as_ref())
            {
                task.iterations = u("iteration") as u32;
            }
            snap.metrics.iterations += 1;
        }
        // The request body is logged before it leaves the process. That is the
        // difference between "model-visible means logged" as a slogan and as
        // a property of the log.
        "model.request" => {
            let record = ModelCallRecord {
                seq: ev.seq,
                // Read the event's own attribution, not the payload: the
                // payload is the request body and must stay wire-shaped.
                task_id: ev.task_id.clone().unwrap_or_default(),
                stage: ev.stage.clone(),
                iteration: u("iteration") as u32,
                model: s("model"),
                message_count: u("messageCount") as u32,
                tools: p
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                tokens_estimate: u("tokensEstimate"),
                request: p.get("messages").cloned().unwrap_or(Value::Null),
                live: p.get("live").and_then(Value::as_bool).unwrap_or(false),
                ..Default::default()
            };
            snap.model_log.push(record);
            if snap.model_log.len() > 8 {
                snap.model_log.remove(0);
            }
        }
        "model.response" => {
            if let Some(last) = snap.model_log.last_mut() {
                last.response_text = s("text");
                last.latency_ms = u("latencyMs");
                last.tool_call_names = p
                    .get("toolCalls")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| c.get("name").and_then(Value::as_str).map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
            }
            snap.metrics.llm_calls += 1;
        }
        "verdict" => {
            let checks: Vec<CriterionView> = p
                .get("checks")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| serde_json::from_value(c.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            let passed = p.get("passed").and_then(Value::as_bool).unwrap_or(false);
            let note = s("note");
            let verdict = VerdictView {
                passed,
                checks: checks.clone(),
                missing: p
                    .get("missing")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                note: note.clone(),
                seq: ev.seq,
            };
            let task_id = ev.task_id.clone().unwrap_or_default();
            if let Some(task) = snap.tasks.iter_mut().find(|t| t.id == task_id) {
                task.criteria = checks;
                task.verdict = Some(verdict);
            }
            if passed {
                snap.metrics.passed += 1;
            } else {
                snap.metrics.rejected += 1;
            }
            snap.boss.mode = "inspect".into();
            snap.boss.note = format!(
                "判定 {} · {}",
                task_id,
                if passed { "通过" } else { "未通过" }
            );
        }
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

/// Which criterion a device's receipt is evidence for. Mirrors the oracle's
/// mapping so the live ledger and the final verdict cannot disagree.
fn criterion_for_tool(name: &str) -> Option<&'static str> {
    match name {
        "kb.search" | "file.read" => Some("source"),
        "data.crosscheck" => Some("crosscheck"),
        "report.render" => Some("delivered"),
        _ => None,
    }
}

/// Read the criteria a turn was opened with. They are declared once, at
/// turn.started, so a resumed log can restore the goal without guessing.
fn parse_criteria(v: Option<&Value>) -> Vec<CriterionView> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let id = c.get("id")?.as_str()?.to_string();
                    let label = c
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(CriterionView {
                        id,
                        label,
                        ok: false,
                        note: "未开始".into(),
                        evidence_seq: 0,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn trim_observations(snap: &mut Snapshot) {
    const MAX: usize = 14;
    if snap.observations.len() > MAX {
        let excess = snap.observations.len() - MAX;
        snap.observations.drain(..excess);
    }
}

/// Turn one read-only observation into append-only facts. Note what is *not*
/// set: no task, worker, item or stage. Camera facts must not enter any work
/// order's derived context or change its state.
pub fn observation_events(
    thread_id: &str,
    cam: &CameraSpec,
    cap: &observe::Capture,
    tick: u64,
) -> Vec<SessionEvent> {
    let mut out = vec![SessionEvent::new(
        0,
        thread_id,
        "camera.capture",
        "camera",
        json!({
            "cameraId": cam.id, "cameraLabel": cam.label, "focus": cam.focus,
            "seen": cap.seen, "checks": cap.checks, "gaps": cap.gaps,
            "coverage": cap.coverage, "blindspots": cap.blindspots.len(),
            "evidenceSeqs": cap.evidence, "note": cap.note,
            "readOnly": true, "tick": tick
        }),
    )];
    for b in &cap.blindspots {
        out.push(SessionEvent::new(
            0,
            thread_id,
            "camera.blindspot",
            "camera",
            json!({
                "cameraId": cam.id, "cameraLabel": cam.label,
                "code": b.code, "subject": b.subject, "note": b.note,
                "evidenceSeqs": b.evidence_seqs, "coverage": cap.coverage,
                "readOnly": true, "tick": tick
            }),
        ));
    }
    out
}

fn apply_control(snap: &mut Snapshot, p: &Value) {
    let action = p.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "pause" => snap.playing = false,
        "resume" => {
            snap.playing = true;
            // A previous shift may have ended with a stop; a resume puts the
            // paused crew back on the floor instead of leaving them frozen.
            for w in &mut snap.workers {
                if w.status == "paused" {
                    w.status = "idle".into();
                }
            }
        }
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

/// Turn one dispatcher decision into append-only facts: the reasoning first,
/// then the move if a floater has to change station.
pub fn dispatch_events(
    thread_id: &str,
    task_id: &str,
    turn_id: &str,
    d: &Decision,
) -> Vec<SessionEvent> {
    let mut out = Vec::new();
    let mut decision = SessionEvent::new(
        0,
        thread_id,
        "dispatch.decision",
        "dispatcher",
        json!({
            "taskId": task_id, "stageId": d.stage_id, "workerId": d.worker_id,
            "workerName": d.worker_name, "score": d.score, "reason": d.reason,
            "alternatives": d.alternatives,
            "note": format!("{} → {} · {}", task_id, d.stage_id, d.reason)
        }),
    )
    .with_task(task_id)
    .with_worker(&d.worker_id)
    .with_stage(&d.stage_id);
    if !turn_id.is_empty() {
        decision = decision.with_turn(turn_id);
    }
    out.push(decision);
    if let Some(from) = &d.reassign_from {
        let mut assigned = SessionEvent::new(
            0,
            thread_id,
            "worker.assigned",
            "dispatcher",
            json!({
                "workerId": d.worker_id, "stageId": d.stage_id, "from": from,
                "note": format!(
                    "{} 从 {} 调往 {}",
                    d.worker_name,
                    if from.is_empty() { "待命区" } else { from.as_str() },
                    d.stage_id
                )
            }),
        )
        .with_task(task_id)
        .with_worker(&d.worker_id)
        .with_stage(&d.stage_id);
        if !turn_id.is_empty() {
            assigned = assigned.with_turn(turn_id);
        }
        out.push(assigned);
    }
    out
}

/// Turn a queued work order into the same three opening facts a demo order
/// produces. This is the single entry point for *all* tasks: the caller only
/// queues, the driver emits, and the agent loop owns everything after that.
pub fn order_events(
    thread_id: &str,
    order: &WorkOrder,
    workers: &[Worker],
) -> Vec<SessionEvent> {
    let turn_id = format!("turn-{}", crate::session::short_id());
    let item_id = format!("item-{}-{}", order.id, crate::session::short_id());
    let criteria: Vec<Value> = order
        .criteria
        .iter()
        .map(|c| json!({ "id": c.id, "label": c.label }))
        .collect();
    let mut out = vec![SessionEvent::new(
        0,
        thread_id,
        "turn.started",
        &order.source,
        json!({
            "taskId": order.id,
            "title": order.title,
            "goal": order.goal,
            "goalId": order.goal_id,
            "criteria": criteria,
            "source": order.source,
            "note": order.note
        }),
    )
    .with_turn(&turn_id)
    .with_task(&order.id)];

    let pick = decide("intake", workers);
    let worker_id = match &pick {
        Some(decision) => {
            out.extend(dispatch_events(thread_id, &order.id, &turn_id, decision));
            decision.worker_id.clone()
        }
        None => "w1".to_string(),
    };
    out.push(
        SessionEvent::new(
            0,
            thread_id,
            "item.started",
            &worker_id,
            json!({
                "kind": "agentMessage",
                "stageId": "intake",
                "dispatched": pick.is_some(),
                "source": order.source
            }),
        )
        .with_turn(&turn_id)
        .with_item(&item_id)
        .with_task(&order.id)
        .with_worker(&worker_id)
        .with_stage("intake"),
    );
    out
}

pub fn plan_tick(
    snap: &Snapshot,
    tick: u64,
    counter: &mut u64,
    seed: &mut u64,
    auto_demo: bool,
) -> TickPlan {
    let mut events = Vec::new();
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let rnd = || -> f64 { ((*seed >> 33) as f64) / (u32::MAX as f64) };

    let thread_id = snap.thread_id.clone();
    let bx = -5.0 + 10.0 * (0.5 + 0.5 * (tick as f64 * 0.11).sin());

    if tick % 3 == 0 {
        events.push(
            SessionEvent::new(0, &thread_id, "boss.patrol", "boss", json!({
                "x": bx, "z": 5.2, "note": "沿流水线巡视"
            })),
        );
    }
    let mut approval: Option<ApprovalPlan> = None;
    for (i, (sid, _name, sx, _color)) in STAGES.iter().enumerate() {
        if (bx - sx).abs() < 0.9 && tick % 3 == 0 {
            events.push(
                SessionEvent::new(0, &thread_id, "boss.inspection", "boss", json!({
                    "x": bx, "stageId": sid, "note": format!("抽查 {} 的产出", sid)
                }))
                .with_stage(sid),
            );
            // The only human gate is now a *device* signature. A random
            // spot-check approval would compete with it for the one approval
            // card in the UI, so patrol stays observational: it reports what
            // the boss saw and never suspends a turn by itself.
        }
        let _ = i;
    }

    let active: Vec<WorkTask> = snap
        .tasks
        .iter()
        .filter(|t| t.status == "running" || t.status == "queued")
        .cloned()
        .collect();

    // Demo orders are opt-in. When the operator is playing, the only work on
    // the floor is what they submitted from the order desk.
    if auto_demo && tick % 8 == 0 && active.len() < 3 {
        *counter += 1;
        let task_id = format!("T{:03}", counter);
        let turn_id = format!("turn-{}", crate::session::short_id());
        let title = TASK_TITLES[(*seed as usize) % TASK_TITLES.len()];
        // The goal is declared up front, not inferred after the fact: the
        // oracle and the model both read the same criteria list.
        let goal = oracle::goal_for(title);
        let criteria: Vec<Value> = goal
            .criteria
            .iter()
            .map(|(id, label)| json!({ "id": id, "label": label }))
            .collect();
        events.push(
            SessionEvent::new(0, &thread_id, "turn.started", "system", json!({
                "taskId": task_id, "title": title,
                "goal": goal.text, "goalId": goal.id, "criteria": criteria,
                "source": "demo", "note": "演示投料 · 可在投单台关闭"
            }))
            .with_turn(&turn_id)
            .with_task(&task_id),
        );
        // Intake is a dispatch decision too, not a constant. The pick and its
        // reasoning go into the log before the worker starts the item.
        let pick = decide("intake", &snap.workers);
        let worker_id = match &pick {
            Some(decision) => {
                events.extend(dispatch_events(&thread_id, &task_id, &turn_id, decision));
                decision.worker_id.clone()
            }
            None => "w1".to_string(),
        };
        events.push(
            SessionEvent::new(0, &thread_id, "item.started", &worker_id, json!({
                "kind": "agentMessage", "stageId": "intake",
                "dispatched": pick.is_some()
            }))
            .with_turn(&turn_id)
            .with_item(&format!("item-{}-{}", task_id, crate::session::short_id()))
            .with_task(&task_id)
            .with_worker(&worker_id)
            .with_stage("intake"),
        );
        if let Some(a) = approval.as_mut() {
            a.turn_id = turn_id;
        }
    }

    for task in &active {
        let progress = task.progress + 0.12 + rnd() * 0.18;
        let index = task.stage_index;
        let turn_id = snap
            .turns
            .iter()
            .rev()
            .find(|t| t.task_id == task.id && t.status == "running")
            .map(|t| t.id.clone())
            .unwrap_or_default();
        let holder = snap
            .workers
            .iter()
            .find(|w| w.task_id.as_deref() == Some(task.id.as_str()))
            .map(|w| w.id.clone());
        if progress >= 1.0 {
            if index + 1 >= STAGES.len() as i32 {
                // Completion belongs to the oracle, not to this tick. If the
                // order ran out of ticks without a verdict, the harness — not
                // the model — failed to close it, and the log says so.
                if task.verdict.is_some() {
                    continue;
                }
                let finisher = holder.clone().unwrap_or_else(|| "w3".to_string());
                let mut ev = SessionEvent::new(0, &thread_id, "turn.failed", &finisher, json!({
                    "taskId": task.id, "workerId": finisher,
                    "reason": "verdict-missing",
                    "note": "工位跑完但没有判定结果"
                }))
                .with_task(&task.id)
                .with_worker(&finisher)
                .with_stage("review");
                if !turn_id.is_empty() {
                    ev = ev.with_turn(&turn_id);
                }
                events.push(ev);
                continue;
            }
            let next = (index + 1) as usize;
            let (sid, _n, _x, _c) = STAGES[next];
            // Hand-off is dispatched too: whoever is free at the next station
            // takes it, and a floater may be moved there first.
            let pick = decide(sid, &snap.workers);
            let wid = match &pick {
                Some(decision) => {
                    events.extend(dispatch_events(&thread_id, &task.id, &turn_id, decision));
                    decision.worker_id.clone()
                }
                None => WORKERS[next].0.to_string(),
            };
            let mut started = SessionEvent::new(0, &thread_id, "item.started", &wid, json!({
                "kind": "agentMessage", "stageId": sid
            }))
            .with_item(&format!("item-{}-{}", task.id, crate::session::short_id()))
            .with_task(&task.id)
            .with_worker(&wid)
            .with_stage(sid);
            if !turn_id.is_empty() {
                started = started.with_turn(&turn_id);
            }
            events.push(started);
            let mut moved = SessionEvent::new(0, &thread_id, "task.moved", &wid, json!({
                "stageIndex": next, "progress": 0.0
            }))
            .with_task(&task.id)
            .with_worker(&wid)
            .with_stage(sid);
            if !turn_id.is_empty() {
                moved = moved.with_turn(&turn_id);
            }
            events.push(moved);
        } else {
            let slot = (index as usize).min(STAGES.len() - 1);
            let (sid, _n, _x, _c) = STAGES[slot];
            let wid = holder.unwrap_or_else(|| WORKERS[slot].0.to_string());
            let mut moved = SessionEvent::new(0, &thread_id, "task.moved", &wid, json!({
                "stageIndex": index, "progress": progress
            }))
            .with_task(&task.id)
            .with_worker(&wid)
            .with_stage(sid);
            if !turn_id.is_empty() {
                moved = moved.with_turn(&turn_id);
            }
            events.push(moved);
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
    let (_stored, frame) = {
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
        "tool.call" => "tool/call",
        "tool.result" => "tool/result",
        "approval.granted" => "approval/granted",
        "approval.denied" => "approval/denied",
        "dispatch.decision" => "dispatch/decision",
        "worker.assigned" => "worker/assigned",
        "camera.capture" => "camera/capture",
        "camera.blindspot" => "camera/blindspot",
        "agent.iteration" => "agent/iteration",
        "model.request" => "model/request",
        "model.response" => "model/response",
        "verdict" => "verdict",
        "turn.failed" => "turn/failed",
        _ => "session/event",
    }
}

/// The driver task: one tick -> one batch of facts -> one possible approval
/// gate. An approval suspends the turn until the UI replies (Codex's
/// server-initiated request pattern).
pub async fn run_driver(state: Arc<AppState>) {
    let mut tick: u64 = 0;
    // Demo orders keep their own T### series; resume it from the log so a
    // restart never reuses an id that is already on the floor.
    let mut counter: u64 = {
        let store = state.store.lock().await;
        store
            .all_events()
            .iter()
            .filter_map(|e| e.task_id.as_deref())
            .filter_map(|t| t.strip_prefix('T').and_then(|s| s.parse::<u64>().ok()))
            .max()
            .unwrap_or(0)
    };
    let mut seed: u64 = 20261120;
    let llm = LlmClient::new();

    let _ = emit(
        &state,
        SessionEvent::new(0, "main", "run.started", "system", json!({
            "note": "班次开始，老板进场（app server 已接管运行时）"
        })),
    )
    .await;
    // A new process takes over the shift: if the replayed log ended stopped,
    // resume explicitly so restarting the server doesn't leave a dead floor.
    let _ = emit(
        &state,
        SessionEvent::new(0, "main", "system.control", "system", json!({
            "action": "resume", "note": "新班次接管，流水线恢复"
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

        let auto_demo = state.config.get().auto_demo;
        let plan = {
            let mut snap = state.snapshot.lock().await;
            snap.tick += 1;
            tick += 1;
            plan_tick(&snap, tick, &mut counter, &mut seed, auto_demo)
        };

        // Every work order — typed in the UI, POSTed with curl, or generated
        // by the demo driver — is drained here and emitted by this loop, so
        // all of them reach run_agent_loop on the identical path.
        let queued: Vec<WorkOrder> = {
            let mut q = state.orders.lock().await;
            let n = q.len().min(3);
            q.drain(..n).collect()
        };
        let mut events: Vec<SessionEvent> = Vec::new();
        if !queued.is_empty() {
            let thread_id = state.active_thread.lock().await.clone();
            let workers = state.snapshot.lock().await.workers.clone();
            for order in &queued {
                events.extend(order_events(&thread_id, order, &workers));
            }
        }
        events.extend(plan.events);

        for ev in events {
            // Once a turn starts, the agent loop owns the item until it either
            // concludes or runs out of iterations.
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
                let (title, criteria_ids) = {
                    let snap = state.snapshot.lock().await;
                    match snap.tasks.iter().find(|t| t.id == task_id) {
                        Some(t) => (
                            t.title.clone(),
                            t.criteria.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
                        ),
                        None => (String::new(), Vec::new()),
                    }
                };
                if let Err(e) = emit(&state, ev).await {
                    eprintln!("emit failed: {e}");
                    continue;
                }
                run_agent_loop(
                    &state,
                    &llm,
                    &thread_id,
                    &turn_id,
                    &item_id,
                    &task_id,
                    &title,
                    &worker_id,
                    &stage,
                    &criteria_ids,
                    tick,
                )
                .await;
            } else if let Err(e) = emit(&state, ev).await {
                eprintln!("emit failed: {e}");
            }
        }

        // Cameras are read-only: they append observation facts and nothing
        // else. Rotate through fixed viewpoints so every station gets covered,
        // and record the gaps that the operator (and the model) cannot see.
        if tick % 6 == 0 {
            let cam = &CAMERAS[(tick as usize / 6) % CAMERAS.len()];
            let events = state.store.lock().await.recent_events(400);
            let mode = state.config.get().mode;
            let thread_id = state.active_thread.lock().await.clone();
            let cap = observe::capture(&events, tick, &mode);
            for ev in observation_events(&thread_id, cam, &cap, tick) {
                if let Err(e) = emit(&state, ev).await {
                    eprintln!("camera emit failed: {e}");
                }
            }
        }

        if let Some(plan) = plan.approval {
            if let Err(e) = request_approval(&state, plan).await {
                eprintln!("approval failed: {e}");
            }
        }
    }
}

/// The agent loop: derive context -> ask the model -> act -> repeat, until the
/// model concludes or the iteration budget runs out. Every step is a logged
/// fact, so replay reproduces the same reasoning path.
#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    state: &Arc<AppState>,
    llm: &LlmClient,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    task_id: &str,
    title: &str,
    worker_id: &str,
    stage: &str,
    criteria: &[String],
    seed: u64,
) {
    let registry = ToolRegistry::builtin();
    let cfg = state.config.get();
    let live = state.config.is_live();
    let provider = state.config.active_provider();
    let key = state.config.api_key();
    // One pass to reach for a device, one to conclude, plus slack for goals
    // that need evidence from more than one criterion.
    let max_iters: u32 = (criteria.len() as u32 + 1).clamp(2, 4);
    let mut conclusion = String::new();

    for iteration in 1..=max_iters {
        let mut iter_ev = SessionEvent::new(
            0,
            thread_id,
            "agent.iteration",
            worker_id,
            json!({
                "iteration": iteration, "max": max_iters,
                "note": format!("第 {}/{} 轮推理", iteration, max_iters)
            }),
        )
        .with_item(item_id)
        .with_task(task_id)
        .with_worker(worker_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            iter_ev = iter_ev.with_turn(turn_id);
        }
        if let Err(e) = emit(state, iter_ev).await {
            eprintln!("agent.iteration failed: {e}");
        }

        // What the model sees, rebuilt from the log — including the receipts
        // of every device the previous iteration started.
        let (ctx, events) = {
            let store = state.store.lock().await;
            let events = store.task_events(task_id);
            (crate::context::derive(&events, task_id, &cfg), events)
        };
        let messages: Vec<Value> = ctx.messages.iter().map(crate::context::wire).collect();
        let tools = registry.as_model_tools();
        let tool_names: Vec<String> = registry.list().iter().map(|t| t.name.clone()).collect();

        // The request body becomes a fact before it leaves the process. That
        // is what makes "model-visible means logged" a property, not a claim.
        let mut req_ev = SessionEvent::new(
            0,
            thread_id,
            "model.request",
            worker_id,
            json!({
                "iteration": iteration,
                // Never label a scripted step with a configured model name:
                // the log must say what actually produced the reply.
                "model": if !live {
                    "(scripted)"
                } else if cfg.model.is_empty() {
                    "(default)"
                } else {
                    cfg.model.as_str()
                },
                "messageCount": messages.len(),
                "messages": messages,
                "tools": tool_names,
                "maxTokens": cfg.max_tokens_per_turn,
                "tokensEstimate": ctx.tokens_estimate,
                "live": live,
                "note": format!(
                    "第 {iteration} 轮请求 · {} 条消息 · {} 台设备",
                    ctx.messages.len(),
                    tool_names.len()
                )
            }),
        )
        .with_item(item_id)
        .with_task(task_id)
        .with_worker(worker_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            req_ev = req_ev.with_turn(turn_id);
        }
        if let Err(e) = emit(state, req_ev).await {
            eprintln!("model.request failed: {e}");
        }

        let reply: AgentReply = if live {
            match (provider.clone(), key.clone()) {
                (Some(p), Some(k)) => {
                    let messages2 = messages.clone();
                    let tools2 = tools.clone();
                    let max_tokens = cfg.max_tokens_per_turn;
                    let llm2: LlmClient = Clone::clone(llm);
                    let outcome = tokio::task::spawn_blocking(move || {
                        let home = crate::config::resolve_home();
                        match crate::config::ConfigStore::load(home).ok() {
                            Some(s) => complete_messages_blocking(
                                &s,
                                &llm2,
                                &p,
                                &k,
                                &messages2,
                                Some(&tools2),
                                max_tokens,
                            ),
                            None => Err(anyhow::anyhow!("配置不可用")),
                        }
                    })
                    .await;
                    match outcome {
                        Ok(Ok(r)) => r,
                        Ok(Err(e)) => {
                            log_model_error(
                                state, thread_id, turn_id, item_id, task_id, worker_id, stage,
                                iteration, &e.to_string(),
                            )
                            .await;
                            break;
                        }
                        Err(e) => {
                            log_model_error(
                                state, thread_id, turn_id, item_id, task_id, worker_id, stage,
                                iteration, &e.to_string(),
                            )
                            .await;
                            break;
                        }
                    }
                }
                _ => break,
            }
        } else {
            let satisfied = satisfied_criteria(&events);
            agent::scripted_step(
                stage,
                title,
                task_id,
                criteria,
                &satisfied,
                iteration,
                seed.wrapping_add(iteration as u64),
            )
        };

        let mut resp_ev = SessionEvent::new(
            0,
            thread_id,
            "model.response",
            worker_id,
            json!({
                "iteration": iteration,
                "text": reply.text,
                "toolCalls": reply.tool_calls.iter().map(|c| json!({
                    "id": c.id, "name": c.name, "arguments": c.arguments
                })).collect::<Vec<_>>(),
                "tokens": reply.tokens,
                "latencyMs": reply.latency_ms,
                "finish": reply.finish
            }),
        )
        .with_item(item_id)
        .with_task(task_id)
        .with_worker(worker_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            resp_ev = resp_ev.with_turn(turn_id);
        }
        if let Err(e) = emit(state, resp_ev).await {
            eprintln!("model.response failed: {e}");
        }

        // Act, then loop: the receipts re-enter the context on the next pass.
        if !reply.tool_calls.is_empty() {
            for call in &reply.tool_calls {
                run_device(state, thread_id, turn_id, task_id, worker_id, stage, call).await;
            }
            continue;
        }

        conclusion = reply.text;
        break;
    }

    if conclusion.trim().is_empty() {
        conclusion = format!("{task_id} 在 {stage} 工位未产出结论（轮次或调用失败）。");
    }

    stream_deltas(
        state, thread_id, turn_id, item_id, task_id, worker_id, stage, &conclusion,
    )
    .await;

    let mut done = SessionEvent::new(
        0,
        thread_id,
        "item.completed",
        worker_id,
        json!({ "kind": "agentMessage", "tokens": 0 }),
    )
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

    // Only the last station closes the order, and only the oracle decides.
    // A model that says "done" is a proposal; the verdict is the ruling.
    if stage == STAGES[STAGES.len() - 1].0 {
        let events = {
            let store = state.store.lock().await;
            store.task_events(task_id)
        };
        // Grade against the criteria declared when the order opened, not a
        // rubric guessed from the title. Custom orders keep their own rules.
        let goal = oracle::goal_from_events(&events, title);
        let verdict = oracle::judge(&events, &goal);
        let mut v_ev = SessionEvent::new(
            0,
            thread_id,
            "verdict",
            "oracle",
            json!({
                "taskId": task_id,
                "passed": verdict.passed,
                "checks": verdict.checks,
                "missing": verdict.missing,
                "note": verdict.note
            }),
        )
        .with_task(task_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            v_ev = v_ev.with_turn(turn_id);
        }
        if let Err(e) = emit(state, v_ev).await {
            eprintln!("verdict failed: {e}");
        }

        let mut end = SessionEvent::new(
            0,
            thread_id,
            if verdict.passed { "turn.completed" } else { "turn.failed" },
            worker_id,
            json!({
                "taskId": task_id,
                "workerId": worker_id,
                "reason": if verdict.passed { "criteria-met" } else { "criteria-missing" },
                "note": verdict.note
            }),
        )
        .with_task(task_id)
        .with_worker(worker_id)
        .with_stage(stage);
        if !turn_id.is_empty() {
            end = end.with_turn(turn_id);
        }
        if let Err(e) = emit(state, end).await {
            eprintln!("turn end failed: {e}");
        }
    }
}

/// Which criteria already have evidence in the log. The scripted policy uses
/// this so it never asks for the same device twice.
fn satisfied_criteria(events: &[SessionEvent]) -> Vec<String> {
    let mut tools: Vec<&str> = Vec::new();
    for ev in events {
        if ev.kind == "tool.result" {
            // A device that was blocked never produced evidence, so it must
            // not count as satisfying its criterion.
            let ok = ev
                .payload
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !ok {
                continue;
            }
            if let Some(name) = ev.payload.get("toolName").and_then(Value::as_str) {
                tools.push(name);
            }
        }
    }
    let mut out = Vec::new();
    if tools.contains(&"kb.search") || tools.contains(&"file.read") {
        out.push("source".to_string());
    }
    if tools.contains(&"data.crosscheck") {
        out.push("crosscheck".to_string());
    }
    if tools.contains(&"report.render") {
        out.push("delivered".to_string());
    }
    if tools.contains(&"shell.exec") {
        out.push("approved".to_string());
    }
    out
}

/// One device invocation, with the approval seam enforced here rather than
/// trusted to whoever asked.
#[allow(clippy::too_many_arguments)]
async fn run_device(
    state: &Arc<AppState>,
    thread_id: &str,
    turn_id: &str,
    task_id: &str,
    worker_id: &str,
    stage: &str,
    call: &agent::ToolCallReq,
) {
    let registry = ToolRegistry::builtin();
    let spec = registry.get(&call.name);
    let label = spec
        .map(|s| s.label.clone())
        .unwrap_or_else(|| call.name.clone());
    let permission = spec
        .map(|s| s.permission.clone())
        .unwrap_or_else(|| "unknown".into());
    let args: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
    let tool_item_id = format!("tool-{}-{}", task_id, crate::session::short_id());

    let mut call_ev = SessionEvent::new(
        0,
        thread_id,
        "tool.call",
        worker_id,
        json!({
            "toolName": call.name, "label": label, "args": args,
            "permission": permission, "stageId": stage, "kind": "toolCall",
            "callId": call.id, "byModel": true
        }),
    )
    .with_item(&tool_item_id)
    .with_task(task_id)
    .with_worker(worker_id)
    .with_stage(stage);
    if !turn_id.is_empty() {
        call_ev = call_ev.with_turn(turn_id);
    }
    if let Err(e) = emit(state, call_ev).await {
        eprintln!("tool.call failed: {e}");
    }

    // A visible "device running" beat before the receipt.
    tokio::time::sleep(Duration::from_millis(90)).await;

    let (ok, receipt, duration_ms) = if spec.is_none() {
        (false, format!("未知设备 {}，未启动", call.name), 0)
    } else if permission == "approval" {
        // The model may *ask* for a risky device. Whether it runs is decided
        // by a server-initiated approval request, never by the model itself.
        let signed = request_tool_approval(
            state, thread_id, turn_id, task_id, worker_id, stage,
            &call.name, &label, &call.id, &args,
        )
        .await;
        if signed {
            let o = registry.execute(&call.name, &args);
            (o.ok, format!("老板签字后执行 · {}", o.receipt), o.duration_ms)
        } else {
            (false, "老板未签字，设备未启动".to_string(), 0)
        }
    } else {
        let o = registry.execute(&call.name, &args);
        (o.ok, o.receipt, o.duration_ms)
    };

    let mut result_ev = SessionEvent::new(
        0,
        thread_id,
        "tool.result",
        worker_id,
        json!({
            "toolName": call.name, "label": label, "ok": ok,
            "receipt": receipt, "durationMs": duration_ms, "callId": call.id
        }),
    )
    .with_item(&tool_item_id)
    .with_task(task_id)
    .with_worker(worker_id)
    .with_stage(stage);
    if !turn_id.is_empty() {
        result_ev = result_ev.with_turn(turn_id);
    }
    if let Err(e) = emit(state, result_ev).await {
        eprintln!("tool.result failed: {e}");
    }
}

/// A risky device suspends the turn until the operator signs. The reply is a
/// server-initiated JSON-RPC request (the same Codex pattern as the boss's
/// inspection gate), and the outcome is written to the log as a signature
/// fact — that fact is the only evidence the oracle accepts for `approved`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn request_tool_approval(
    state: &Arc<AppState>,
    thread_id: &str,
    turn_id: &str,
    task_id: &str,
    worker_id: &str,
    stage: &str,
    tool_name: &str,
    label: &str,
    call_id: &str,
    args: &Value,
) -> bool {
    let id = state.next_request_id();
    let (tx, rx) = oneshot::channel::<ApprovalReply>();
    state.approvals.lock().await.insert(id, tx);

    state.broadcast(RpcMessage::request(
        Value::from(id),
        "approval/request",
        json!({
            "kind": "tool",
            "toolName": tool_name,
            "label": label,
            "callId": call_id,
            "args": args,
            "stage": stage,
            "taskId": task_id,
            "turnId": turn_id,
            "note": format!("工人 {} 想启动「{}」，这台设备需要老板签字", worker_id, label),
            "options": ["allow", "deny"]
        }),
    ));

    // An unattended request must not wedge the workshop forever. The safe
    // default for a privileged device is to refuse, not to auto-allow.
    let (reply, expired) = match tokio::time::timeout(Duration::from_secs(25), rx).await {
        Ok(Ok(r)) => (r, false),
        _ => (
            ApprovalReply {
                decision: "deny".into(),
                note: "超时自动驳回".into(),
            },
            true,
        ),
    };
    if expired {
        state.broadcast(RpcMessage::notification(
            "approval/expired",
            json!({ "id": id, "decision": "deny", "note": "超时自动驳回" }),
        ));
    }

    let allow = reply.decision == "allow";
    let mut ev = SessionEvent::new(
        0,
        thread_id,
        if allow { "approval.granted" } else { "approval.denied" },
        "boss",
        json!({
            "decision": if allow { "allow" } else { "deny" },
            "toolName": tool_name,
            "callId": call_id,
            "taskId": task_id,
            "note": format!(
                "{} · {}",
                if allow { "签字放行" } else { "驳回" },
                reply.note
            ),
            "by": "human"
        }),
    )
    .with_item(&format!("approval-{}-{}", task_id, crate::session::short_id()))
    .with_task(task_id)
    .with_worker(worker_id)
    .with_stage(stage);
    if !turn_id.is_empty() {
        ev = ev.with_turn(turn_id);
    }
    if let Err(e) = emit(state, ev).await {
        eprintln!("approval fact failed: {e}");
    }
    allow
}

/// Stream the conclusion as deltas so the UI and the derived context see the
/// same bytes. Replay rebuilds the exact same item.
#[allow(clippy::too_many_arguments)]
async fn stream_deltas(
    state: &Arc<AppState>,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    task_id: &str,
    worker_id: &str,
    stage: &str,
    text: &str,
) {
    let chunks: Vec<String> = text
        .chars()
        .collect::<Vec<char>>()
        .chunks(14)
        .map(|c| c.iter().collect())
        .collect();
    for chunk in &chunks {
        let mut ev = SessionEvent::new(
            0,
            thread_id,
            "item.agentMessage.delta",
            worker_id,
            json!({ "delta": chunk, "tokens": 6 }),
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
    }
}

/// A failed model call is still a fact: the log must show the loop stopped
/// because the model was unreachable, not because it concluded.
#[allow(clippy::too_many_arguments)]
async fn log_model_error(
    state: &Arc<AppState>,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    task_id: &str,
    worker_id: &str,
    stage: &str,
    iteration: u32,
    message: &str,
) {
    let mut ev = SessionEvent::new(
        0,
        thread_id,
        "model.error",
        worker_id,
        json!({ "iteration": iteration, "message": message }),
    )
    .with_item(item_id)
    .with_task(task_id)
    .with_worker(worker_id)
    .with_stage(stage);
    if !turn_id.is_empty() {
        ev = ev.with_turn(turn_id);
    }
    let _ = emit(state, ev).await;
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
