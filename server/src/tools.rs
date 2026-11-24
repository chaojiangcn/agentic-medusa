//! Tool registry — the office's equipment ledger.
//!
//! A tool is a named, schema-described capability the *host* exposes. The
//! browser never executes anything: it only sees the ledger (tools/list),
//! the tool_call / tool_result receipts in the session log, and the derived
//! ToolView in each Snapshot.
//!
//! In mock mode execute() is deterministic and side-effect free, so replay
//! stays reproducible. Swapping in real file/shell executors is one seam.

use crate::protocol::{ToolOutcome, ToolSpec};
use serde_json::{json, Value};

const SPECS: &[(&str, &str, &str, &str, &str)] = &[
    ("kb.search", "知识库检索机", "按关键词检索内部知识条目", "intake", "safe"),
    ("file.read", "档案柜", "读取工作区内的文档片段", "intake", "safe"),
    ("data.crosscheck", "交叉校验台", "比对两份数据并标出差异", "analysis", "safe"),
    ("shell.exec", "命令终端", "在沙盒里执行一条本地命令", "analysis", "approval"),
    ("cite.verify", "引用校对器", "核对结论与引用来源是否一致", "review", "safe"),
    ("report.render", "装订机", "把结论渲染成交付件", "review", "safe"),
];

fn schema(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false
    })
}

fn spec(name: &str, label: &str, desc: &str, stage: &str, permission: &str) -> ToolSpec {
    let input_schema = match name {
        "kb.search" => schema(json!({
            "query": { "type": "string", "description": "检索关键词" },
            "topK": { "type": "integer", "description": "返回条数" }
        }), &["query"]),
        "file.read" => schema(json!({
            "path": { "type": "string", "description": "相对工作区路径" }
        }), &["path"]),
        "data.crosscheck" => schema(json!({
            "sourceA": { "type": "string" }, "sourceB": { "type": "string" }
        }), &["sourceA", "sourceB"]),
        "shell.exec" => schema(json!({
            "command": { "type": "string", "description": "要执行的命令" }
        }), &["command"]),
        "cite.verify" => schema(json!({
            "claim": { "type": "string" }, "source": { "type": "string" }
        }), &["claim"]),
        "report.render" => schema(json!({
            "template": { "type": "string" }, "format": { "type": "string" }
        }), &["template"]),
        _ => json!({ "type": "object", "properties": {} }),
    };
    ToolSpec {
        name: name.into(),
        label: label.into(),
        description: desc.into(),
        stage_id: stage.into(),
        permission: permission.into(),
        input_schema,
    }
}

pub struct ToolRegistry {
    specs: Vec<ToolSpec>,
}

impl ToolRegistry {
    pub fn builtin() -> Self {
        Self {
            specs: SPECS.iter().map(|(n, l, d, s, p)| spec(n, l, d, s, p)).collect(),
        }
    }

    pub fn list(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.specs.iter().find(|t| t.name == name)
    }

    /// Deterministic, side-effect free execution. Real executors plug in here.
    pub fn execute(&self, name: &str, args: &Value) -> ToolOutcome {
        let arg = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        let receipt = match name {
            "kb.search" => format!("命中 5 条：{}", arg("query")),
            "file.read" => format!("已读取 {}（节选 240 字）", arg("path")),
            "data.crosscheck" => format!("{} ↔ {}：发现 2 处差异", arg("sourceA"), arg("sourceB")),
            "shell.exec" => format!("$ {} → exit 0", arg("command")),
            "cite.verify" => format!("引用校验通过：{}", arg("claim")),
            "report.render" => format!("已生成 {} 交付件（{}）", arg("template"), arg("format")),
            _ => format!("未知设备 {} 无输出", name),
        };
        ToolOutcome {
            ok: true,
            receipt,
            duration_ms: 40 + (name.len() as u64 * 7),
        }
    }

    /// Exactly what a chat-completions request would carry in "tools".
    pub fn as_model_tools(&self) -> Value {
        Value::Array(
            self.specs
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema
                    }
                }))
                .collect(),
        )
    }
}

/// Deterministic sample arguments for the mock driver.
pub fn sample_args(name: &str, task_id: &str) -> Value {
    match name {
        "kb.search" => json!({ "query": format!("工单 {} 相关上下文", task_id), "topK": 5 }),
        "file.read" => json!({ "path": format!("notes/{}.md", task_id) }),
        "data.crosscheck" => json!({ "sourceA": "知识库快照", "sourceB": format!("{} 结论草稿", task_id) }),
        "shell.exec" => json!({ "command": "echo ok" }),
        "cite.verify" => json!({ "claim": format!("{} 结论", task_id), "source": "内部知识库" }),
        "report.render" => json!({ "template": "结论摘要", "format": "markdown" }),
        _ => json!({}),
    }
}
