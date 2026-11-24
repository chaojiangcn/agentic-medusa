//! Observation layer — cameras are read-only roles.
//!
//! A camera is *not* another boss. It never decides who gets a work order,
//! never intervenes, never touches a task, worker, device or the boss. It only
//! appends two kinds of facts to the same append-only log:
//!
//!   `camera.capture`    what was visible in a window of key facts
//!   `camera.blindspot`  a gap in the log — something nobody can see
//!
//! That distinction is the whole point. Observability is a property of the
//! log, not of the 3D scene: the meshes are a projection, the facts are truth.
//!
//! Observation facts deliberately carry **no** `taskId`, `workerId` or
//! `stage`. They hang on the wall, not in a worker's file, so they can never
//! leak into a derived model context or change a work order's state.

use crate::protocol::SessionEvent;
use serde_json::Value;
use std::collections::HashMap;

pub struct CameraSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// What this fixed viewpoint is responsible for watching.
    pub focus: &'static str,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Three fixed viewpoints. The camera rotates through them; it does not
/// follow the boss, because following a decision-maker would make observation
/// a function of the decision instead of an independent record.
pub const CAMERAS: [CameraSpec; 3] = [
    CameraSpec {
        id: "cam-intake",
        label: "进料口 · 1 号机",
        focus: "投料与派单",
        x: -7.8,
        y: 4.5,
        z: -1.2,
    },
    CameraSpec {
        id: "cam-floor",
        label: "车间全景 · 2 号机",
        focus: "工位交接与设备",
        x: 0.0,
        y: 5.6,
        z: -6.4,
    },
    CameraSpec {
        id: "cam-review",
        label: "交付口 · 3 号机",
        focus: "结论与交付",
        x: 7.8,
        y: 4.5,
        z: -1.2,
    },
];

/// Gaps that are *structural*: the camera can see them but cannot fix them.
/// These are reported by `camera/list`, not written as log facts, because they
/// don't come and go with the shift — they are properties of the harness.
pub const STRUCTURAL_BLINDSPOTS: &[(&str, &str)] = &[
    (
        "model-request",
        "mock 模式下没有「模型实际收到的请求 / 原始响应」事实，日志里只有派生依据。",
    ),
    (
        "tool-timing",
        "设备小票只记结果与耗时，没有失败重试、部分输出或副作用的记录。",
    ),
    (
        "context-truncation",
        "派生上下文按预算截断时，被丢掉的历史不会回灌给工人。",
    ),
    (
        "human-decision",
        "人工放行 / 叫停只留下结论，没留下决策依据。",
    ),
];

/// High-frequency facts that would drown the observability window, plus the
/// camera's own facts: observation must not observe itself.
fn is_noise(kind: &str) -> bool {
    matches!(
        kind,
        "item.agentMessage.delta"
            | "task.moved"
            | "boss.patrol"
            | "boss.inspection"
            | "run.started"
            | "thread.started"
            | "thread.resumed"
            | "camera.capture"
            | "camera.blindspot"
    )
}

pub struct Blindspot {
    pub code: &'static str,
    pub subject: String,
    pub note: String,
    pub evidence_seqs: Vec<u64>,
}

pub struct Capture {
    /// How many key facts were in the window.
    pub seen: usize,
    /// Pairing checks performed (call→receipt, started→completed, ...).
    pub checks: u32,
    pub gaps: u32,
    pub coverage: f64,
    pub evidence: Vec<u64>,
    pub note: String,
    pub blindspots: Vec<Blindspot>,
}

fn str_field(ev: &SessionEvent, key: &str) -> String {
    ev.payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Look at the tail of the log and report what is visible and what is missing.
///
/// Pure function: no state, no I/O, no side effects. Callers decide whether to
/// write the resulting facts. `mode` is used for the one structural gap a
/// camera can freshly discover on its very first capture.
pub fn capture(events: &[SessionEvent], tick: u64, mode: &str) -> Capture {
    let key: Vec<&SessionEvent> = events.iter().filter(|e| !is_noise(&e.kind)).collect();
    let start = key.len().saturating_sub(72);
    let window = &key[start..];

    let mut item_starts: HashMap<String, &SessionEvent> = HashMap::new();
    let mut item_ends: Vec<String> = Vec::new();
    let mut calls: HashMap<String, &SessionEvent> = HashMap::new();
    let mut receipts: Vec<String> = Vec::new();
    let mut turns: Vec<(String, &SessionEvent)> = Vec::new();
    let mut dispatched: Vec<String> = Vec::new();
    let mut blocked: Vec<(String, u64, &SessionEvent)> = Vec::new();
    let mut resumed: Vec<(String, u64)> = Vec::new();

    for &ev in window {
        let task = ev.task_id.clone().unwrap_or_default();
        match ev.kind.as_str() {
            "item.started" => {
                if let Some(id) = &ev.item_id {
                    item_starts.insert(id.clone(), ev);
                }
            }
            "item.completed" => {
                if let Some(id) = &ev.item_id {
                    item_ends.push(id.clone());
                }
            }
            "tool.call" => {
                if let Some(id) = &ev.item_id {
                    calls.insert(id.clone(), ev);
                }
            }
            "tool.result" => {
                if let Some(id) = &ev.item_id {
                    receipts.push(id.clone());
                }
            }
            "turn.started" => turns.push((task, ev)),
            "dispatch.decision" => {
                let id = str_field(ev, "taskId");
                if !id.is_empty() {
                    dispatched.push(id);
                } else {
                    dispatched.push(task);
                }
            }
            "worker.blocked" => blocked.push((
                ev.worker_id.clone().unwrap_or_default(),
                ev.seq,
                ev,
            )),
            "worker.resumed" => resumed.push((
                ev.worker_id.clone().unwrap_or_default(),
                ev.seq,
            )),
            _ => {}
        }
    }

    let mut blindspots: Vec<Blindspot> = Vec::new();
    let mut checks = 0u32;
    let mut gaps = 0u32;

    // 1. A device was started but never produced a receipt.
    for (item, ev) in &calls {
        checks += 1;
        if !receipts.iter().any(|r| r == item) {
            gaps += 1;
            let name = str_field(ev, "toolName");
            blindspots.push(Blindspot {
                code: "orphan-tool-call",
                subject: ev.task_id.clone().unwrap_or_else(|| item.clone()),
                note: format!("设备 {} 启动了，日志里却没有对应结果小票", name),
                evidence_seqs: vec![ev.seq],
            });
        }
    }

    // 2. An item opened but never closed — the worker went silent on the log.
    for (item, ev) in &item_starts {
        checks += 1;
        if !item_ends.iter().any(|i| i == item) {
            gaps += 1;
            blindspots.push(Blindspot {
                code: "silent-item",
                subject: ev.task_id.clone().unwrap_or_else(|| item.clone()),
                note: format!(
                    "工件 {} 开工后没有完成记录，看不到它的结论",
                    ev.item_id.clone().unwrap_or_default()
                ),
                evidence_seqs: vec![ev.seq],
            });
        }
    }

    // 3. A work order appeared without a dispatcher decision: black-box
    //    assignment, nobody can reconstruct why it went where it went.
    for (task, ev) in &turns {
        checks += 1;
        if !dispatched.iter().any(|d| d == task) {
            gaps += 1;
            blindspots.push(Blindspot {
                code: "missing-dispatch",
                subject: task.clone(),
                note: "工单开了头却没有派单决策，无法还原「为什么给他」".into(),
                evidence_seqs: vec![ev.seq],
            });
        }
    }

    // 4. A blocked worker with no later resume fact: the log shows the block
    //    but not how (or whether) it was cleared.
    for (worker, seq, ev) in &blocked {
        checks += 1;
        let cleared = resumed.iter().any(|(w, rseq)| w == worker && *rseq > *seq);
        if !cleared {
            gaps += 1;
            blindspots.push(Blindspot {
                code: "unresolved-block",
                subject: worker.clone(),
                note: format!("工人 {} 进入阻塞后没有恢复记录", worker),
                evidence_seqs: vec![ev.seq],
            });
        }
    }

    // The first time a camera opens its eye in mock mode it discovers the
    // harness's honest structural gap: the model's raw request/response never
    // entered the log. Report it once as a fact, not on every capture.
    let first_capture = !events.iter().any(|e| e.kind == "camera.capture");
    if first_capture && mode == "mock" {
        checks += 1;
        gaps += 1;
        blindspots.push(Blindspot {
            code: "model-request-unlogged",
            subject: "model-adapter".into(),
            note: "mock 模式没有把模型原始请求 / 响应写成事实，只能靠日志派生".into(),
            evidence_seqs: Vec::new(),
        });
    }

    let coverage = if checks == 0 {
        1.0
    } else {
        ((checks - gaps) as f64 / checks as f64 * 100.0).round() / 100.0
    };
    let evidence = window
        .iter()
        .rev()
        .take(6)
        .map(|e| e.seq)
        .collect::<Vec<u64>>();
    let note = format!(
        "第 {} 次抓拍 · 看见 {} 条关键事实 · 覆盖率 {}% · 盲区 {} 处",
        tick / 6,
        window.len(),
        (coverage * 100.0).round() as u32,
        blindspots.len()
    );

    Capture {
        seen: window.len(),
        checks,
        gaps,
        coverage,
        evidence,
        note,
        blindspots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, kind: &str, item: Option<&str>, task: Option<&str>) -> SessionEvent {
        let mut e = SessionEvent::new(
            seq,
            "main",
            kind,
            "system",
            json!({ "toolName": "kb.search", "taskId": task.unwrap_or("") }),
        );
        if let Some(i) = item {
            e = e.with_item(i);
        }
        if let Some(t) = task {
            e = e.with_task(t);
        }
        e
    }

    #[test]
    fn a_complete_pair_is_observable() {
        let events = vec![
            ev(1, "turn.started", None, Some("T1")),
            ev(2, "dispatch.decision", None, Some("T1")),
            ev(3, "item.started", Some("i1"), Some("T1")),
            ev(4, "item.completed", Some("i1"), Some("T1")),
            ev(5, "tool.call", Some("t1"), Some("T1")),
            ev(6, "tool.result", Some("t1"), Some("T1")),
        ];
        let cap = capture(&events, 6, "live");
        assert_eq!(cap.gaps, 0, "every fact has its counterpart");
        assert_eq!(cap.coverage, 1.0);
        assert!(cap.blindspots.is_empty());
    }

    #[test]
    fn a_missing_receipt_is_a_blind_spot() {
        let events = vec![
            ev(1, "turn.started", None, Some("T1")),
            ev(2, "dispatch.decision", None, Some("T1")),
            ev(3, "tool.call", Some("t1"), Some("T1")),
        ];
        let cap = capture(&events, 6, "live");
        assert_eq!(cap.gaps, 1);
        assert_eq!(cap.blindspots[0].code, "orphan-tool-call");
        assert_eq!(cap.blindspots[0].evidence_seqs, vec![3]);
        assert!(cap.coverage < 1.0);
    }

    #[test]
    fn black_box_assignment_is_detected() {
        let events = vec![ev(1, "turn.started", None, Some("T9"))];
        let cap = capture(&events, 6, "live");
        assert!(cap.blindspots.iter().any(|b| b.code == "missing-dispatch"));
    }

    #[test]
    fn observation_never_observes_itself() {
        let events = vec![
            ev(1, "tool.call", Some("t1"), Some("T1")),
            ev(2, "tool.result", Some("t1"), Some("T1")),
            ev(3, "camera.capture", None, None),
            ev(4, "camera.blindspot", None, None),
        ];
        let cap = capture(&events, 12, "live");
        assert_eq!(cap.seen, 2, "camera facts must not enter the window");
    }

    #[test]
    fn first_mock_capture_reports_the_structural_gap() {
        let cap = capture(&[], 6, "mock");
        assert!(cap
            .blindspots
            .iter()
            .any(|b| b.code == "model-request-unlogged"));
        let later = capture(
            &[ev(1, "camera.capture", None, None)],
            12,
            "mock",
        );
        assert!(!later
            .blindspots
            .iter()
            .any(|b| b.code == "model-request-unlogged"));
    }
}
