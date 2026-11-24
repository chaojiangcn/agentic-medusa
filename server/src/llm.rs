//! Optional real model calls. Requests leave the local process, not the
//! browser: this is the layer Codex Desktop hides inside its Host. In `mock`
//! mode nothing outbound happens, so the workshop runs with zero config.

use crate::agent::{AgentReply, ToolCallReq};
use crate::config::ConfigStore;
use crate::protocol::ModelProvider;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Cloneable so the blocking worker can carry the same budget counters.
#[derive(Clone)]
pub struct LlmClient {
    calls_this_minute: Arc<AtomicU64>,
    minute_start: Arc<AtomicU64>,
}

impl LlmClient {
    pub fn new() -> Self {
        Self {
            calls_this_minute: Arc::new(AtomicU64::new(0)),
            minute_start: Arc::new(AtomicU64::new(unix_secs())),
        }
    }

    pub fn budget_left(&self, cfg: &ConfigStore) -> bool {
        let now = unix_secs();
        if now.saturating_sub(self.minute_start.load(Ordering::Relaxed)) >= 60 {
            self.minute_start.store(now, Ordering::Relaxed);
            self.calls_this_minute.store(0, Ordering::Relaxed);
        }
        let max = cfg.get().max_calls_per_minute as u64;
        self.calls_this_minute.load(Ordering::Relaxed) < max.max(1)
    }
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Send a derived message array. This is the path the driver uses: `messages`
/// comes from `context::derive`, so what the log calls "model-visible" is
/// literally what goes out on the wire.
pub fn complete_messages_blocking(
    cfg: &ConfigStore,
    client: &LlmClient,
    provider: &ModelProvider,
    key: &str,
    messages: &[Value],
    tools: Option<&Value>,
    max_tokens: u64,
) -> Result<AgentReply> {
    if !client.budget_left(cfg) {
        return Err(anyhow!("预算闸口：本分钟调用次数已达上限"));
    }
    client.calls_this_minute.fetch_add(1, Ordering::Relaxed);

    let started = Instant::now();
    let base = provider.base_url.trim_end_matches('/');
    let (url, body) = if provider.wire_api == "responses" {
        // The Responses API has a different tool-calling shape; keep the
        // conversation roles it understands and skip tools for now.
        let input: Vec<Value> = messages
            .iter()
            .filter_map(|m| {
                let role = m.get("role").and_then(Value::as_str)?;
                if role == "system" || role == "user" || role == "assistant" {
                    Some(json!({
                        "role": role,
                        "content": m.get("content").cloned().unwrap_or_else(|| json!(""))
                    }))
                } else {
                    None
                }
            })
            .collect();
        (
            format!("{base}/responses"),
            json!({
                "model": provider.model,
                "input": input,
                "max_output_tokens": max_tokens.min(4000)
            }),
        )
    } else {
        let mut body = json!({
            "model": provider.model,
            "messages": messages,
            "max_tokens": max_tokens.min(4000),
            "stream": false
        });
        if let Some(t) = tools {
            if t.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                body["tools"] = t.clone();
            }
        }
        (format!("{base}/chat/completions"), body)
    };

    // The local process issues the request, not the browser. We shell out to
    // curl so the server has no TLS dependency at all (Codex Desktop similarly
    // keeps the credential and the outbound call inside the local host).
    let body_text = serde_json::to_string(&body)?;
    let output = std::process::Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "45",
            "-X",
            "POST",
            &url,
            "-H",
            &format!("Authorization: Bearer {}", key),
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("User-Agent: {}", crate::protocol::USER_AGENT),
            "--data-binary",
            "@-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(body_text.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|e| anyhow!("curl 启动失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("模型请求失败: {}", stderr.trim()));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| anyhow!("模型响应解析失败: {} · {}", e, String::from_utf8_lossy(&output.stdout)))?;

    let (text, tool_calls, finish) = if provider.wire_api == "responses" {
        (extract_responses_text(&value), Vec::new(), "stop".to_string())
    } else {
        let content = value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // A model that answers with a tool call has no content. Parse the
        // calls into structured requests instead of flattening them into
        // prose — the loop has to *execute* them, not narrate them.
        let calls = parse_tool_calls(&value);
        let finish = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or(if calls.is_empty() { "stop" } else { "tool_calls" })
            .to_string();
        (content, calls, finish)
    };

    let usage = value.get("usage");
    let tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| (text.chars().count() as u64) / 2 + 32);

    Ok(AgentReply {
        text,
        tool_calls,
        tokens,
        latency_ms: started.elapsed().as_millis() as u64,
        finish,
    })
}

/// Read the calls a chat-completions response asked for. Malformed entries
/// are skipped rather than failing the turn: a missing name is not a reason
/// to lose the whole reply.
fn parse_tool_calls(v: &Value) -> Vec<ToolCallReq> {
    let Some(arr) = v
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|c| {
            let name = c.pointer("/function/name").and_then(Value::as_str)?;
            if name.is_empty() {
                return None;
            }
            let id = c
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments = c
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string();
            Some(ToolCallReq {
                id: if id.is_empty() { format!("call-{name}") } else { id },
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn extract_responses_text(v: &Value) -> String {
    if let Some(arr) = v.get("output").and_then(Value::as_array) {
        let mut out = String::new();
        for item in arr {
            if let Some(parts) = item.get("content").and_then(Value::as_array) {
                for p in parts {
                    if let Some(t) = p.get("text").and_then(Value::as_str) {
                        out.push_str(t);
                    }
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    v.get("output_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
