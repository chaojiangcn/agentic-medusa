//! The model seam.
//!
//! The loop in `workshop::run_agent_loop` does not care whether a reply came
//! from a network call or from `scripted_step`. That is the whole point of a
//! harness: swapping the model must not change the control flow, the facts
//! written to the log, or the verdict that ends the turn.
//!
//! `scripted_step` is not a stub that pretends to think. It is a deterministic
//! policy used in mock mode: it reads the goal's unmet criteria and asks for
//! the device that can satisfy one. It runs the *same* multi-step loop, so the
//! log looks identical whether or not a key is configured.

use crate::tools::sample_args;

#[derive(Debug, Clone)]
pub struct ToolCallReq {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct AgentReply {
    pub text: String,
    pub tool_calls: Vec<ToolCallReq>,
    pub tokens: u64,
    pub latency_ms: u64,
    /// "stop" | "tool_calls" | "length" — mirrors the wire's finish_reason.
    pub finish: String,
}

impl AgentReply {
    pub fn text_only(text: String, tokens: u64, latency_ms: u64) -> Self {
        Self {
            text,
            tool_calls: Vec::new(),
            tokens,
            latency_ms,
            finish: "stop".into(),
        }
    }
}

/// Which device can satisfy a criterion at a given station. Stations are a
/// pipeline, so a criterion is only actionable where its device lives.
fn device_for(criterion: &str, stage: &str) -> Option<&'static str> {
    match (criterion, stage) {
        ("source", "intake") => Some("kb.search"),
        ("crosscheck", "analysis") => Some("data.crosscheck"),
        ("delivered", "review") => Some("report.render"),
        // A compliance goal may reach for the shell. The request is legitimate;
        // whether it runs is the approval seam's call, not the model's.
        ("approved", "review") => Some("shell.exec"),
        _ => None,
    }
}

/// One deterministic policy step.
pub fn scripted_step(
    stage: &str,
    title: &str,
    task_id: &str,
    criteria: &[String],
    satisfied: &[String],
    iteration: u32,
    seed: u64,
) -> AgentReply {
    // First pass at a station: reach for the device that closes an open
    // criterion. Later passes: report the conclusion.
    if iteration == 1 {
        let mut calls = Vec::new();
        for (idx, cid) in criteria.iter().enumerate() {
            if satisfied.iter().any(|s| s == cid) {
                continue;
            }
            if let Some(name) = device_for(cid, stage) {
                if calls.iter().any(|c: &ToolCallReq| c.name == name) {
                    continue;
                }
                calls.push(ToolCallReq {
                    id: format!("call-{}-{}-{}-{}", task_id, stage, iteration, idx),
                    name: name.into(),
                    arguments: sample_args(name, task_id).to_string(),
                });
            }
        }
        if !calls.is_empty() {
            return AgentReply {
                text: String::new(),
                tool_calls: calls,
                tokens: 72,
                latency_ms: 110,
                finish: "tool_calls".into(),
            };
        }
    }

    let text = conclusion_text(stage, title, task_id, criteria.len(), seed);
    AgentReply::text_only(text, 96, 140)
}

/// A station-appropriate conclusion. Kept short and concrete: it is read by
/// the next station's model, not by a human.
fn conclusion_text(stage: &str, title: &str, task_id: &str, criteria: usize, seed: u64) -> String {
    let variants: [String; 3] = match stage {
        "intake" => [
            format!("{}：拆出 {} 个关键步骤，来源已标注，交给分析工位。", task_id, 2 + seed % 3),
            format!("「{}」的需求要点已归纳，附 3 条可回溯出处。", title),
            format!("{} 检索完成，命中 5 条内部知识，取前 3 条作为依据。", task_id),
        ],
        "analysis" => [
            format!("{}：完成交叉比对，标出 2 处口径差异并给出建议。", task_id),
            format!("「{}」的结论已按证据整理，{} 条判据已对齐。", title, criteria),
            format!("{} 分析完成，冲突项已单列，其余可直接采用。", task_id),
        ],
        "review" => [
            format!("{}：引用逐条核对通过，交付件已渲染。", task_id),
            format!("「{}」质检完成，未发现未标注的推断。", title),
            format!("{} 已装订成交付件，判据自检结果一并附上。", task_id),
        ],
        _ => [format!("{} 完成本工位一轮工作。", task_id), format!("{} 已处理。", title), format!("{} 完成。", task_id)],
    };
    variants[(seed as usize) % variants.len()].clone()
}
