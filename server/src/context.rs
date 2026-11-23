//! Context derivation — "what does the model actually see?"
//!
//! The App Server rule is *model-visible means logged*: every request must be
//! reconstructable from the append-only session log. `derive()` is that
//! reconstruction. It walks one work order's facts (turn -> items -> tool
//! calls/results) and produces the exact message array a chat-completions
//! call would carry, plus the `sourceSeqs` that produced each message.
//!
//! Two things this makes real instead of decorative:
//!   * device receipts feed back into the next request as `role: "tool"`;
//!   * the UI can show the derived messages *and* the request body, so the
//!     context window stops being invisible.

use crate::protocol::{AppConfig, ContextMessage, DerivedContext, SessionEvent};
use crate::tools::ToolRegistry;
use serde_json::{json, Value};
use std::collections::HashMap;

const ROLE: &str = "你是 Medusa 流水线上的 LLM 工人：只负责当前工位这一步，\
输出简短、具体、可被下一工位直接使用。不要臆造上下文里没有的数字或结论。";

/// Render one context message on the wire (no `sourceSeqs`, which are for
/// humans auditing the log, not for the model).
pub fn wire(m: &ContextMessage) -> Value {
    let mut v = json!({ "role": m.role, "content": m.content });
    if let Some(name) = &m.name {
        v["name"] = json!(name);
    }
    if let Some(id) = &m.tool_call_id {
        v["tool_call_id"] = json!(id);
    }
    if let Some(calls) = &m.tool_calls {
        v["tool_calls"] = calls.clone();
    }
    v
}

/// Rough token estimate: CJK ≈ 1 token/char, ASCII ≈ 1 token/3 chars.
fn estimate(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for ch in text.chars() {
        if ch as u32 > 0x2e80 {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other / 3 + 4
}

fn text_of<'a>(ev: &'a SessionEvent, key: &str) -> &'a str {
    ev.payload.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Rebuild the model context for `task_id` from that task's logged facts.
pub fn derive(events: &[SessionEvent], task_id: &str, cfg: &AppConfig) -> DerivedContext {
    let scoped: Vec<&SessionEvent> = events
        .iter()
        .filter(|e| e.task_id.as_deref() == Some(task_id))
        .collect();

    let mut title = String::new();
    let mut stage = String::new();
    let mut worker_id = String::new();
    let mut turn_id = String::new();
    for ev in &scoped {
        if ev.kind == "turn.started" {
            let t = text_of(ev, "title");
            if !t.is_empty() {
                title = t.to_string();
            }
            if let Some(t) = &ev.turn_id {
                turn_id = t.clone();
            }
        }
        if !ev.stage.is_empty() {
            stage = ev.stage.clone();
        }
        if let Some(w) = &ev.worker_id {
            worker_id = w.clone();
        }
    }

    let registry = ToolRegistry::builtin();
    let devices: Vec<_> = registry
        .list()
        .into_iter()
        .filter(|d| stage.is_empty() || d.stage_id == stage)
        .collect();
    let device_lines = devices
        .iter()
        .map(|d| {
            format!(
                "- {}（{}）：{}{}",
                d.label,
                d.name,
                d.description,
                if d.permission == "approval" {
                    "〔需老板签字〕"
                } else {
                    "〔可直接用〕"
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!(
        "{ROLE}\n当前工位：{}\n可用设备：\n{}\n\
         规则：需要外部信息就调用设备；高风险设备必须等老板签字；只输出本工位结论。",
        if stage.is_empty() { "未分配" } else { &stage },
        if device_lines.is_empty() {
            "- 本工位暂无设备".to_string()
        } else {
            device_lines
        }
    );

    // Walk the facts in order. Item deltas accumulate into one assistant
    // message at `item.completed`; tool calls and receipts become their own
    // messages so the next request can use the output of the equipment.
    let mut item_text: HashMap<String, String> = HashMap::new();
    let mut item_seqs: HashMap<String, Vec<u64>> = HashMap::new();
    let mut call_ids: HashMap<String, String> = HashMap::new();
    let mut history: Vec<ContextMessage> = Vec::new();

    for ev in &scoped {
        match ev.kind.as_str() {
            "item.started" => {
                if let Some(id) = &ev.item_id {
                    item_text.insert(id.clone(), String::new());
                    item_seqs.insert(id.clone(), vec![ev.seq]);
                }
            }
            "item.agentMessage.delta" => {
                if let Some(id) = &ev.item_id {
                    if let Some(delta) = ev.payload.get("delta").and_then(Value::as_str) {
                        if let Some(buf) = item_text.get_mut(id) {
                            buf.push_str(delta);
                        }
                    }
                    if let Some(seqs) = item_seqs.get_mut(id) {
                        seqs.push(ev.seq);
                    }
                }
            }
            "item.completed" => {
                if let Some(id) = &ev.item_id {
                    let text = item_text.remove(id).unwrap_or_default();
                    let mut seqs = item_seqs.remove(id).unwrap_or_default();
                    seqs.push(ev.seq);
                    if text.trim().is_empty() {
                        continue;
                    }
                    history.push(ContextMessage {
                        role: "assistant".into(),
                        name: Some(format!(
                            "{}@{}",
                            ev.worker_id.clone().unwrap_or_default(),
                            ev.stage
                        )),
                        content: text,
                        tool_call_id: None,
                        tool_calls: None,
                        source_seqs: seqs,
                    });
                }
            }
            "tool.call" => {
                let name = text_of(ev, "toolName").to_string();
                let label = {
                    let l = text_of(ev, "label");
                    if l.is_empty() { name.clone() } else { l.to_string() }
                };
                let args = ev.payload.get("args").cloned().unwrap_or_else(|| json!({}));
                let args_text = serde_json::to_string(&args).unwrap_or_default();
                let call_id = format!("call-{}", ev.seq);
                if let Some(id) = &ev.item_id {
                    call_ids.insert(id.clone(), call_id.clone());
                }
                history.push(ContextMessage {
                    role: "assistant".into(),
                    name: None,
                    content: format!("调用设备 {label}：{args_text}"),
                    tool_call_id: None,
                    tool_calls: Some(json!([{
                        "id": call_id,
                        "type": "function",
                        "function": { "name": name, "arguments": args_text }
                    }])),
                    source_seqs: vec![ev.seq],
                });
            }
            "tool.result" => {
                let receipt = text_of(ev, "receipt").to_string();
                let name = text_of(ev, "toolName").to_string();
                let call_id = ev
                    .item_id
                    .as_ref()
                    .and_then(|id| call_ids.get(id).cloned())
                    .unwrap_or_else(|| format!("call-{}", ev.seq));
                history.push(ContextMessage {
                    role: "tool".into(),
                    name: if name.is_empty() { None } else { Some(name) },
                    content: receipt,
                    tool_call_id: Some(call_id),
                    tool_calls: None,
                    source_seqs: vec![ev.seq],
                });
            }
            _ => {}
        }
    }

    // Only completed worker answers count as upstream deliverables; tool
    // calls are assistant-role too, but they are not a hand-off.
    let upstream = history
        .iter()
        .filter(|m| m.role == "assistant" && m.tool_calls.is_none())
        .count();
    let user = format!(
        "工单 {task_id}「{}」\n当前工位：{}\n上游交付：{upstream} 条\n请给出本工位可直接交给下一环节的结论。",
        if title.is_empty() { "未命名工单" } else { &title },
        if stage.is_empty() { "未分配" } else { &stage }
    );

    let mut messages = vec![
        ContextMessage {
            role: "system".into(),
            content: system,
            ..Default::default()
        },
        ContextMessage {
            role: "user".into(),
            content: user,
            ..Default::default()
        },
    ];

    // Budget: keep system + user, then the newest history that fits.
    let budget = cfg.max_tokens_per_turn.max(256);
    let base_tokens: u64 = messages.iter().map(|m| estimate(&m.content)).sum();
    let mut used = base_tokens + history.iter().map(|m| estimate(&m.content)).sum::<u64>();
    let mut dropped = 0u32;
    while used > budget && history.len() > 1 {
        if let Some(first) = history.first() {
            used -= estimate(&first.content);
            history.remove(0);
            dropped += 1;
        }
    }
    if dropped > 0 {
        let next_seq = history
            .first()
            .and_then(|m| m.source_seqs.first().copied())
            .unwrap_or(0);
        messages.push(ContextMessage {
            role: "system".into(),
            content: format!("上下文按预算截断：省略较早的 {dropped} 条记录，剩余从 seq {next_seq} 开始。"),
            ..Default::default()
        });
    }
    messages.extend(history);

    let tokens_estimate = messages.iter().map(|m| estimate(&m.content)).sum();
    let model_request = json!({
        "model": if cfg.model.is_empty() { "(mock)" } else { cfg.model.as_str() },
        "messages": messages.iter().map(wire).collect::<Vec<_>>(),
        "tools": registry.as_model_tools(),
        "max_tokens": budget,
        "stream": false,
        "note": "由 append-only 会话日志派生；sourceSeqs 指回原始事实，仅用于审计。"
    });

    DerivedContext {
        task_id: task_id.to_string(),
        turn_id,
        stage,
        worker_id,
        messages,
        tokens_estimate,
        budget,
        dropped,
        tools: devices.iter().map(|d| d.name.clone()).collect(),
        model_request,
    }
}
