//! Acceptance criteria — the harness's answer to "is this work order done?"
//!
//! A progress bar reaching 1.0 is a UI fiction. A verdict is a fact: it is
//! computed from the log by a pure function, so replaying the same facts
//! yields the same answer. That is what makes "the work is finished"
//! auditable instead of asserted.
//!
//! A goal owns a small set of criteria. Each criterion is decidable from
//! logged facts alone — no model judgement, no heuristics, no side channel.

use crate::protocol::CriterionView;
use crate::protocol::SessionEvent;
use std::collections::HashSet;

const C_CONCLUSION: (&str, &str) = ("conclusion", "有可交付结论");
const C_SOURCE: (&str, &str) = ("source", "结论有来源支撑");
const C_CROSSCHECK: (&str, &str) = ("crosscheck", "做过交叉校验");
const C_DELIVERED: (&str, &str) = ("delivered", "产出交付件");
const C_APPROVED: (&str, &str) = ("approved", "高风险动作已签字");

/// A work order's objective, plus the criteria that decide whether it is met.
pub struct Goal {
    pub id: String,
    pub text: String,
    pub criteria: Vec<(&'static str, &'static str)>,
}

/// The judge's output. `checks` is the whole ledger, not just the failures:
/// a passing verdict should show *why* it passed.
pub struct Verdict {
    pub passed: bool,
    pub checks: Vec<CriterionView>,
    pub missing: Vec<String>,
    pub note: String,
}

/// Every title the generator produces maps to a goal. Different goals need
/// different evidence, so the same loop can pass one order and fail another —
/// otherwise "all criteria satisfied" would be a constant.
pub fn goal_for(title: &str) -> Goal {
    let (id, text, criteria): (&str, &str, Vec<(&'static str, &'static str)>) = match title {
        "交叉验证数据" => (
            "verify-data",
            "两份数据交叉比对，标出差异",
            vec![C_CONCLUSION, C_CROSSCHECK],
        ),
        "整理交付件" => (
            "package",
            "把结论整理成可交付的成品",
            vec![C_CONCLUSION, C_DELIVERED],
        ),
        "汇总多方结论" => (
            "synthesize",
            "汇总多来源结论并交付",
            vec![C_CONCLUSION, C_CROSSCHECK, C_DELIVERED],
        ),
        "合规复核" => (
            "compliance",
            "复核结论是否合规且可追溯",
            vec![C_CONCLUSION, C_SOURCE, C_APPROVED],
        ),
        "校对引用来源" => (
            "cite-check",
            "核对每条结论的引用来源",
            vec![C_CONCLUSION, C_SOURCE],
        ),
        "解析需求文档" => (
            "parse",
            "拆出需求里的关键步骤",
            vec![C_CONCLUSION, C_SOURCE],
        ),
        "检索内部知识" => (
            "lookup",
            "检索并归纳内部知识",
            vec![C_CONCLUSION, C_SOURCE],
        ),
        _ => (
            "draft",
            "产出一份能直接交给下一环节的结论",
            vec![C_CONCLUSION],
        ),
    };
    Goal {
        id: id.into(),
        text: text.into(),
        criteria,
    }
}

/// Judge one work order from its own facts. `events` must already be scoped
/// to the order (turn.started .. now), oldest first.
pub fn judge(events: &[SessionEvent], goal: &Goal) -> Verdict {
    // A conclusion is not "some text was produced": the item has to be both
    // streamed (delta) and closed (completed), or it is a half-written draft.
    let mut streamed: HashSet<String> = HashSet::new();
    let mut closed: HashSet<String> = HashSet::new();
    let mut conclusion_seq = 0u64;
    let mut devices: Vec<(String, u64)> = Vec::new();
    let mut approval_seq = 0u64;

    for ev in events {
        match ev.kind.as_str() {
            "item.agentMessage.delta" => {
                if let Some(id) = &ev.item_id {
                    streamed.insert(id.clone());
                }
            }
            "item.completed" => {
                if let Some(id) = &ev.item_id {
                    if streamed.contains(id) && conclusion_seq == 0 {
                        conclusion_seq = ev.seq;
                    }
                    closed.insert(id.clone());
                }
            }
            "tool.result" => {
                let name = ev
                    .payload
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !name.is_empty() {
                    devices.push((name, ev.seq));
                }
            }
            "boss.intervention" => {
                let note = ev
                    .payload
                    .get("note")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if note.contains("审批") {
                    approval_seq = ev.seq;
                }
            }
            _ => {}
        }
    }

    let has_conclusion = streamed.intersection(&closed).next().is_some();
    let used = |names: &[&str]| -> Option<u64> {
        devices
            .iter()
            .find(|(n, _)| names.contains(&n.as_str()))
            .map(|(_, seq)| *seq)
    };

    let mut checks = Vec::new();
    for (id, label) in &goal.criteria {
        let (ok, note, evidence) = match *id {
            "conclusion" => (
                has_conclusion,
                if has_conclusion {
                    "工件已闭合，可交给下一环节".to_string()
                } else {
                    "没有任何一条工件被写完".to_string()
                },
                if conclusion_seq > 0 { conclusion_seq } else { 0 },
            ),
            "source" => match used(&["kb.search", "file.read"]) {
                Some(seq) => (true, "调用了检索设备，结论可回溯".to_string(), seq),
                None => (false, "没有检索或读档记录".to_string(), 0),
            },
            "crosscheck" => match used(&["data.crosscheck"]) {
                Some(seq) => (true, "交叉校验台出过小票".to_string(), seq),
                None => (false, "没有交叉校验记录".to_string(), 0),
            },
            "delivered" => match used(&["report.render"]) {
                Some(seq) => (true, "装订机产出过交付件".to_string(), seq),
                None => (false, "没有交付件产出".to_string(), 0),
            },
            "approved" => match used(&["shell.exec"]) {
                Some(seq) if approval_seq == 0 => (
                    false,
                    "高风险设备被调用，但没有签字记录".to_string(),
                    seq,
                ),
                Some(_) => (true, "高风险动作有签字".to_string(), approval_seq),
                // No risky device was touched, so the criterion is vacuous.
                None => (true, "未触发高风险动作".to_string(), 0),
            },
            _ => (true, "未定义的判据，默认放行".to_string(), 0),
        };
        if !ok {
            checks.push(CriterionView {
                id: (*id).into(),
                label: (*label).into(),
                ok,
                note,
                evidence_seq: evidence,
            });
        } else {
            checks.push(CriterionView {
                id: (*id).into(),
                label: (*label).into(),
                ok,
                note,
                evidence_seq: evidence,
            });
        }
    }

    let missing: Vec<String> = checks
        .iter()
        .filter(|c| !c.ok)
        .map(|c| c.label.clone())
        .collect();
    let passed = missing.is_empty();
    let note = if passed {
        format!("{} 条判据全部满足", checks.len())
    } else {
        format!("缺 {} 条：{}", missing.len(), missing.join("、"))
    };

    Verdict {
        passed,
        checks,
        missing,
        note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, kind: &str, item: Option<&str>, payload: serde_json::Value) -> SessionEvent {
        let mut e = SessionEvent::new(seq, "main", kind, "w1", payload).with_task("T001");
        if let Some(id) = item {
            e = e.with_item(id);
        }
        e
    }

    #[test]
    fn conclusion_requires_a_closed_item() {
        let goal = goal_for("生成结论草稿");
        let events = vec![ev(
            1,
            "item.agentMessage.delta",
            Some("i1"),
            json!({ "delta": "结论" }),
        )];
        let v = judge(&events, &goal);
        assert!(!v.passed, "a streamed but unclosed item is still a draft");
    }

    #[test]
    fn conclusion_passes_once_the_item_closes() {
        let goal = goal_for("生成结论草稿");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({ "kind": "agentMessage" })),
        ];
        assert!(judge(&events, &goal).passed);
    }

    #[test]
    fn missing_source_fails_a_goal_that_needs_evidence() {
        let goal = goal_for("解析需求文档");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({})),
        ];
        let v = judge(&events, &goal);
        assert!(!v.passed);
        assert!(v.missing.iter().any(|m| m.contains("来源")));
    }

    #[test]
    fn source_receipt_satisfies_the_evidence_criterion() {
        let goal = goal_for("解析需求文档");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({})),
            ev(3, "tool.result", Some("t1"), json!({ "toolName": "kb.search" })),
        ];
        assert!(judge(&events, &goal).passed);
    }

    #[test]
    fn risky_device_without_a_signature_fails() {
        let goal = goal_for("合规复核");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({})),
            ev(3, "tool.result", Some("t1"), json!({ "toolName": "kb.search" })),
            ev(4, "tool.result", Some("t2"), json!({ "toolName": "shell.exec" })),
        ];
        let v = judge(&events, &goal);
        assert!(!v.passed);
        assert!(v.missing.iter().any(|m| m.contains("签字")));
    }

    #[test]
    fn signature_clears_the_risky_criterion() {
        let goal = goal_for("合规复核");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({})),
            ev(3, "tool.result", Some("t1"), json!({ "toolName": "kb.search" })),
            ev(4, "tool.result", Some("t2"), json!({ "toolName": "shell.exec" })),
            ev(5, "boss.intervention", None, json!({ "note": "审批 allow" })),
        ];
        assert!(judge(&events, &goal).passed);
    }

    #[test]
    fn same_facts_yield_the_same_verdict() {
        let goal = goal_for("汇总多方结论");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "a" })),
            ev(2, "item.completed", Some("i1"), json!({})),
            ev(3, "tool.result", Some("t1"), json!({ "toolName": "data.crosscheck" })),
            ev(4, "tool.result", Some("t2"), json!({ "toolName": "report.render" })),
        ];
        let a = judge(&events, &goal);
        let b = judge(&events, &goal);
        assert_eq!(a.passed, b.passed);
        assert_eq!(a.missing, b.missing);
    }
}
