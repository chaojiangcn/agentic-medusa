//! Wire protocol — the single source of truth for both sides of the wire.
//!
//! Shaped after the Codex App Server: bidirectional JSON-RPC 2.0, an
//! `initialize` handshake, and three conversation primitives with explicit
//! lifecycles: Thread (a persisted shift) > Turn (one work order) > Item
//! (one worker action, started -> delta -> completed).
//!
//! `ts-rpc/generate.sh` mirrors the public types into TypeScript; the
//! frontend must not hand-write a second copy of the schema.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "2026-11-20";
pub const USER_AGENT: &str = concat!("medusa-app-server/", env!("CARGO_PKG_VERSION"));

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcMessage {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcMessage {
    pub fn request(id: Value, method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: Some(id),
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    pub fn notification(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: Some(id),
            method: None,
            params: None,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: Some(id),
            method: None,
            params: None,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }

    pub fn is_notification(&self) -> bool {
        self.id.is_none() && self.method.is_some()
    }
}

pub const ERR_NOT_INITIALIZED: i64 = -32000;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
pub const ERR_OVERLOADED: i64 = -32001;

// ---------------------------------------------------------------------------
// Session log — append-only. "Model-visible means logged."
// ---------------------------------------------------------------------------

/// One immutable fact. Every event that can affect model-visible context or
/// workshop state is written here, in order, and never mutated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub seq: u64,
    pub ts: i64,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// e.g. "item.started", "item.agentMessage.delta", "boss.inspection"
    pub kind: String,
    pub actor: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    pub payload: Value,
}

impl SessionEvent {
    pub fn new(
        seq: u64,
        thread_id: &str,
        kind: &str,
        actor: &str,
        payload: Value,
    ) -> Self {
        Self {
            seq,
            ts: now_ms(),
            thread_id: thread_id.into(),
            turn_id: None,
            item_id: None,
            kind: kind.into(),
            actor: actor.into(),
            stage: String::new(),
            task_id: None,
            worker_id: None,
            payload,
        }
    }

    pub fn with_turn(mut self, turn_id: &str) -> Self {
        self.turn_id = Some(turn_id.into());
        self
    }
    pub fn with_item(mut self, item_id: &str) -> Self {
        self.item_id = Some(item_id.into());
        self
    }
    pub fn with_stage(mut self, stage: &str) -> Self {
        self.stage = stage.into();
        self
    }
    pub fn with_task(mut self, task_id: &str) -> Self {
        self.task_id = Some(task_id.into());
        self
    }
    pub fn with_worker(mut self, worker_id: &str) -> Self {
        self.worker_id = Some(worker_id.into());
        self
    }
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub head_seq: u64,
    pub turn_count: u32,
    pub status: String, // "active" | "archived" | "forked"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    pub id: String,
    pub thread_id: String,
    pub task_id: String,
    pub status: String, // "running" | "completed" | "interrupted" | "paused"
    pub started_at: i64,
    pub items: u32,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: String,
    pub turn_id: String,
    pub kind: String, // "agentMessage" | "toolCall" | "approvalRequest" | "review"
    pub status: String, // "started" | "completed"
    pub worker_id: String,
    pub stage: String,
    pub text: String,
    pub tokens: u64,
}

// ---------------------------------------------------------------------------
// Workshop projection — derived from the log, never stored as truth.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub position: Vec3,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub id: String,
    pub name: String,
    pub model: String,
    pub stage_id: String,
    pub status: String,
    pub load: f64,
    pub tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Per-role model override (Medusa: each worker can carry its own config).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    pub id: String,
    pub title: String,
    pub stage_index: i32,
    pub progress: f64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Boss {
    pub x: f64,
    pub z: f64,
    pub target_stage_id: String,
    pub mode: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub tokens: u64,
    pub cost: f64,
    pub active_workers: u32,
    pub blocked: u32,
    pub completed: u32,
    pub failed: u32,
    pub throughput: f64,
    pub llm_calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub run_id: String,
    pub seq: u64,
    pub tick: u64,
    pub thread_id: String,
    pub playing: bool,
    pub speed: f64,
    pub stages: Vec<Stage>,
    pub workers: Vec<Worker>,
    pub tasks: Vec<WorkTask>,
    pub boss: Boss,
    pub metrics: Metrics,
    pub threads: Vec<ThreadInfo>,
    pub turns: Vec<TurnInfo>,
    pub items: Vec<ItemInfo>,
    /// Most recent session event, for the event-stream panel.
    pub last_event: Option<SessionEvent>,
}

/// One replayable frame. The frontend keeps these in memory for scrubbing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub event: SessionEvent,
    pub snapshot: Snapshot,
}

// ---------------------------------------------------------------------------
// Configuration — lives on the process side; the API key never reaches the UI.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    /// Only the *name* of the env var is stored in the config file.
    pub env_key: String,
    pub wire_api: String, // "chat" | "responses"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// "mock" (no outbound calls) | "live" (workers call the configured model)
    pub mode: String,
    pub model: String,
    pub model_provider: String,
    pub providers: Vec<ModelProvider>,
    pub tick_ms: u64,
    pub max_tokens_per_turn: u64,
    pub max_calls_per_minute: u32,
    /// Redacted view returned to the UI: never carries a secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            mode: "mock".into(),
            model: String::new(),
            model_provider: String::new(),
            providers: Vec::new(),
            tick_ms: 420,
            max_tokens_per_turn: 4000,
            max_calls_per_minute: 20,
            has_api_key: None,
        }
    }
}

/// What `config/read` returns — secrets replaced by a boolean.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub mode: String,
    pub model: String,
    pub model_provider: String,
    pub providers: Vec<ModelProvider>,
    pub tick_ms: u64,
    pub max_tokens_per_turn: u64,
    pub max_calls_per_minute: u32,
    pub has_api_key: bool,
    pub protocol_version: String,
    pub user_agent: String,
    pub config_home: String,
}
