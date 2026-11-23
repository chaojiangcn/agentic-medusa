//! Optional real model calls. Requests leave the local process, not the
//! browser: this is the layer Codex Desktop hides inside its Host. In `mock`
//! mode nothing outbound happens, so the workshop runs with zero config.

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
) -> Result<LlmResult> {
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

    let text = if provider.wire_api == "responses" {
        extract_responses_text(&value)
    } else {
        let content = value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or("");
        if content.trim().is_empty() {
            // A model that answers with a tool call has no content. Surface the
            // intent instead of an empty item; executing it is the next layer.
            extract_tool_intent(&value)
        } else {
            content.to_string()
        }
    };

    let usage = value.get("usage");
    let tokens = usage
        .and_then(|u| u.get("total_tokens").or_else(|| u.get("total_tokens")))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| (text.chars().count() as u64) / 2 + 32);

    Ok(LlmResult {
        text,
        tokens,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

fn extract_tool_intent(v: &Value) -> String {
    let Some(calls) = v
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let parts: Vec<String> = calls
        .iter()
        .map(|c| {
            let name = c
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let args = c
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("[模型请求调用设备] {name}({args})")
        })
        .collect();
    parts.join(" ")
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

pub struct LlmResult {
    pub text: String,
    pub tokens: u64,
    pub latency_ms: u64,
}

/// Deterministic mock output, used when no key is configured.
pub fn mock_text(stage: &str, task: &str, seed: u64) -> String {
    let variants = [
        format!("已解析「{}」：拆出 3 个关键步骤，按依赖排序后交给下游。", task),
        format!("检索到相关上下文 5 条，交叉比对完成，置信度 0.{}。", 70 + seed % 29),
        format!("{} 工位完成一轮推理，结论已写入工件，等待质检。", stage),
        format!("发现一处口径不一致，已标注并附上原始出处，建议复核。",),
        format!("汇总前序产出，形成可交付草稿，共 {} 个要点。", 3 + seed % 4),
    ];
    variants[(seed as usize) % variants.len()].clone()
}
