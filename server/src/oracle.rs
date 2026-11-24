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
use serde_json::Value;
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
    /// Owned strings: an operator can declare their own criteria at
    /// turn.started, so the goal is no longer limited to built-in tuples.
    pub criteria: Vec<(String, String)>,
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
        criteria: criteria
            .into_iter()
            .map(|(id, label)| (id.to_string(), label.to_string()))
            .collect(),
    }
}

/// Rebuild a work order's goal from its own opening fact. The judge must read
/// the criteria the operator declared, not re-guess them from the title:
/// otherwise a custom order would be graded against a different rubric than
/// the model was given. Falls back to the built-in goal for old logs.
pub fn goal_from_events(events: &[SessionEvent], title: &str) -> Goal {
    let fallback = goal_for(title);
    let opening = events.iter().find(|e| e.kind == "turn.started");
    let Some(ev) = opening else { return fallback };
    let Some(arr) = ev.payload.get("criteria").and_then(Value::as_array) else {
        return fallback;
    };
    let criteria: Vec<(String, String)> = arr
        .iter()
        .filter_map(|c| {
            let id = c.get("id").and_then(Value::as_str)?;
            let label = c.get("label").and_then(Value::as_str).unwrap_or(id);
            Some((id.to_string(), label.to_string()))
        })
        .collect();
    if criteria.is_empty() {
        return fallback;
    }
    Goal {
        id: ev
            .payload
            .get("goalId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("custom")
            .to_string(),
        text: ev
            .payload
            .get("goal")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback.text.as_str())
            .to_string(),
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
    /// A risky device was *asked for* or ran, whether or not it succeeded.
    /// A refused call still counts as an attempt that needed a signature.
    let mut risky_seq = 0u64;

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
            "tool.call" => {
                let name = ev
                    .payload
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let permission = ev
                    .payload
                    .get("permission")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if (permission == "approval" || name == "shell.exec") && risky_seq == 0 {
                    risky_seq = ev.seq;
                }
            }
            "tool.result" => {
                let name = ev
                    .payload
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if name == "shell.exec" && risky_seq == 0 {
                    risky_seq = ev.seq;
                }
                // A refused device produces no evidence. Counting it would
                // let a blocked shell call satisfy a criterion on its own.
                let ok = ev
                    .payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if !ok {
                    continue;
                }
                if !name.is_empty() {
                    devices.push((name, ev.seq));
                }
            }
            // A tool approval is a first-class signature fact. The older
            // boss/intervention note is still accepted for replayed logs.
            "approval.granted" => {
                let decision = ev
                    .payload
                    .get("decision")
                    .and_then(Value::as_str)
                    .unwrap_or("allow");
                if decision == "allow" {
                    approval_seq = ev.seq;
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
        let (ok, note, evidence) = match id.as_str() {
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
            // Declaring `approved` is a requirement, not a conditional. A
            // denied or timed-out signature must fail the order — otherwise
            // "reject" would be indistinguishable from "pass".
            "approved" => {
                if approval_seq > 0 {
                    (true, "高风险动作有签字".to_string(), approval_seq)
                } else if risky_seq > 0 {
                    (
                        false,
                        "高风险设备被调用，但没有签字记录（被驳回或超时）".to_string(),
                        risky_seq,
                    )
                } else {
                    (false, "声明了签字判据，但日志里没有签字事实".to_string(), 0)
                }
            }
            _ => (false, "未定义的判据，日志里找不到证据".to_string(), 0),
        };
        checks.push(CriterionView {
            id: id.clone(),
            label: label.clone(),
            ok,
            note,
            evidence_seq: evidence,
        });
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
    fn custom_criteria_come_from_the_opening_fact() {
        let events = vec![ev(
            1,
            "turn.started",
            None,
            json!({
                "title": "用户自己起的名字",
                "goal": "自定义目标",
                "goalId": "custom",
                "criteria": [{ "id": "source", "label": "结论有来源支撑" }]
            }),
        )];
        let goal = goal_from_events(&events, "用户自己起的名字");
        assert_eq!(goal.id, "custom");
        assert_eq!(goal.criteria.len(), 1, "must not fall back to a title-based goal");
        assert_eq!(goal.criteria[0].0, "source");
        assert!(!judge(&events, &goal).passed, "no search receipt means the declared criterion is unmet");
    }

    #[test]
    fn tool_signature_clears_a_custom_approved_criterion() {
        let events = vec![
            ev(1, "turn.started", None, json!({
                "title": "合规复核",
                "criteria": [{ "id": "approved", "label": "高风险动作已签字" }]
            })),
            ev(2, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(3, "item.completed", Some("i1"), json!({})),
            ev(4, "tool.result", Some("t2"), json!({ "toolName": "shell.exec", "ok": true })),
            ev(5, "approval.granted", None, json!({ "decision": "allow", "toolName": "shell.exec" })),
        ];
        let goal = goal_from_events(&events, "合规复核");
        assert!(judge(&events, &goal).passed);
    }

    #[test]
    fn a_denied_signature_fails_the_approved_criterion() {
        let events = vec![
            ev(1, "turn.started", None, json!({
                "title": "合规复核",
                "criteria": [{ "id": "approved", "label": "高风险动作已签字" }]
            })),
            ev(2, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(3, "item.completed", Some("i1"), json!({})),
            ev(4, "tool.call", Some("t2"), json!({ "toolName": "shell.exec", "permission": "approval" })),
            ev(5, "approval.denied", None, json!({ "decision": "deny", "toolName": "shell.exec" })),
            ev(6, "tool.result", Some("t2"), json!({ "toolName": "shell.exec", "ok": false, "receipt": "老板未签字" })),
        ];
        let goal = goal_from_events(&events, "合规复核");
        let v = judge(&events, &goal);
        assert!(!v.passed, "a refused call must not pass as 'no risky action'");
        assert!(v.missing.iter().any(|m| m.contains("签字")));
    }

    #[test]
    fn declared_signature_with_no_signature_fact_fails() {
        let goal = goal_for("合规复核");
        let events = vec![
            ev(1, "item.agentMessage.delta", Some("i1"), json!({ "delta": "结论" })),
            ev(2, "item.completed", Some("i1"), json!({})),
            ev(3, "tool.result", Some("t1"), json!({ "toolName": "kb.search", "ok": true })),
        ];
        assert!(!judge(&events, &goal).passed);
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
