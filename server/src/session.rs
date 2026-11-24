//! Append-only session log, following the Codex App Server rule:
//! "Model-visible means logged. Every model request must be reconstructable
//! from the log." State is a *projection* of the log, not a second truth.

use crate::protocol::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct SessionStore {
    dir: PathBuf,
    /// All events, in global seq order, across every thread.
    events: Vec<SessionEvent>,
    threads: HashMap<String, ThreadInfo>,
    turns: HashMap<String, TurnInfo>,
    items: HashMap<String, ItemInfo>,
    seq: u64,
}

impl SessionStore {
    pub fn open(dir: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&dir)?;
        let mut store = Self {
            dir,
            events: Vec::new(),
            threads: HashMap::new(),
            turns: HashMap::new(),
            items: HashMap::new(),
            seq: 0,
        };
        store.load_from_disk()?;
        if store.threads.is_empty() {
            store.create_thread("main", "主流水线 · 班次 001", None)?;
        }
        Ok(store)
    }

    fn load_from_disk(&mut self) -> anyhow::Result<()> {
        let mut files: Vec<PathBuf> = fs::read_dir(&self.dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
            .collect();
        files.sort();
        for path in files {
            let file = match File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(ev) = serde_json::from_str::<SessionEvent>(&line) {
                    self.seq = self.seq.max(ev.seq);
                    self.apply_projection(&ev);
                    self.events.push(ev);
                }
            }
        }
        self.events.sort_by_key(|e| e.seq);
        Ok(())
    }

    pub fn home(&self) -> &PathBuf {
        &self.dir
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn create_thread(
        &mut self,
        id: &str,
        title: &str,
        forked_from: Option<String>,
    ) -> anyhow::Result<ThreadInfo> {
        let info = ThreadInfo {
            id: id.into(),
            title: title.into(),
            created_at: now_ms(),
            head_seq: self.seq,
            turn_count: 0,
            status: "active".into(),
            forked_from,
        };
        self.threads.insert(id.into(), info.clone());
        let ev = SessionEvent::new(
            self.seq + 1,
            id,
            "thread.started",
            "system",
            json!({ "title": title }),
        );
        self.append(ev)?;
        Ok(info)
    }

    /// Append one immutable fact. Never mutates history.
    pub fn append(&mut self, ev: SessionEvent) -> anyhow::Result<SessionEvent> {
        let mut ev = ev;
        self.seq += 1;
        ev.seq = self.seq;
        if ev.ts == 0 {
            ev.ts = now_ms();
        }
        let line = serde_json::to_string(&ev)?;
        let path = self.dir.join(format!("{}.jsonl", safe_name(&ev.thread_id)));
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{}", line)?;
        self.apply_projection(&ev);
        self.events.push(ev.clone());
        Ok(ev)
    }

    fn apply_projection(&mut self, ev: &SessionEvent) {
        if let Some(t) = self.threads.get_mut(&ev.thread_id) {
            t.head_seq = ev.seq;
        }
        match ev.kind.as_str() {
            "turn.started" => {
                if let (Some(tid), Some(turn_id)) = (&ev.task_id, &ev.turn_id) {
                    self.turns.insert(
                        turn_id.clone(),
                        TurnInfo {
                            id: turn_id.clone(),
                            thread_id: ev.thread_id.clone(),
                            task_id: tid.clone(),
                            status: "running".into(),
                            started_at: ev.ts,
                            items: 0,
                            tokens: 0,
                        },
                    );
                    if let Some(t) = self.threads.get_mut(&ev.thread_id) {
                        t.turn_count += 1;
                    }
                }
            }
            "turn.completed" | "turn.interrupted" => {
                if let Some(turn_id) = &ev.turn_id {
                    if let Some(t) = self.turns.get_mut(turn_id) {
                        t.status = if ev.kind == "turn.completed" {
                            "completed".into()
                        } else {
                            "interrupted".into()
                        };
                    }
                }
            }
            "item.started" => {
                if let (Some(item_id), Some(turn_id)) = (&ev.item_id, &ev.turn_id) {
                    let kind = ev
                        .payload
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("agentMessage")
                        .to_string();
                    self.items.insert(
                        item_id.clone(),
                        ItemInfo {
                            id: item_id.clone(),
                            turn_id: turn_id.clone(),
                            kind,
                            status: "started".into(),
                            worker_id: ev.worker_id.clone().unwrap_or_default(),
                            stage: ev.stage.clone(),
                            text: String::new(),
                            tokens: 0,
                        },
                    );
                    if let Some(t) = self.turns.get_mut(turn_id) {
                        t.items += 1;
                    }
                }
            }
            "item.agentMessage.delta" | "item.completed" => {
                if let Some(item_id) = &ev.item_id {
                    if let Some(item) = self.items.get_mut(item_id) {
                        if let Some(delta) = ev.payload.get("delta").and_then(Value::as_str) {
                            item.text.push_str(delta);
                        }
                        let tokens = ev
                            .payload
                            .get("tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        item.tokens += tokens;
                        if let Some(t) = self.turns.get_mut(&item.turn_id) {
                            t.tokens += tokens;
                        }
                        if ev.kind == "item.completed" {
                            item.status = "completed".into();
                        }
                    }
                }
            }
            "tool.call" => {
                // A tool call is an Item even when it was fired manually
                // (tools/call) with no enclosing turn: the ledger must show
                // every capability the host exercised.
                if let Some(item_id) = &ev.item_id {
                    let name = ev
                        .payload
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    self.items.insert(
                        item_id.clone(),
                        ItemInfo {
                            id: item_id.clone(),
                            turn_id: ev.turn_id.clone().unwrap_or_default(),
                            kind: "toolCall".into(),
                            status: "started".into(),
                            worker_id: ev.worker_id.clone().unwrap_or_default(),
                            stage: ev.stage.clone(),
                            text: name,
                            tokens: 0,
                        },
                    );
                    if let Some(turn_id) = &ev.turn_id {
                        if let Some(t) = self.turns.get_mut(turn_id) {
                            t.items += 1;
                        }
                    }
                }
            }
            "tool.result" => {
                if let Some(item_id) = &ev.item_id {
                    if let Some(item) = self.items.get_mut(item_id) {
                        if let Some(receipt) = ev.payload.get("receipt").and_then(Value::as_str) {
                            item.text = receipt.into();
                        }
                        item.status = "completed".into();
                    }
                }
            }
            _ => {}
        }
    }

    /// Replay events for a thread. `after_seq` supports resuming from where a
    /// client left off, which is how the UI survives a page reload.
    pub fn events_for(&self, thread_id: &str, after_seq: u64) -> Vec<SessionEvent> {
        self.events
            .iter()
            .filter(|e| e.thread_id == thread_id && e.seq > after_seq)
            .cloned()
            .collect()
    }

    pub fn all_events(&self) -> Vec<SessionEvent> {
        self.events.clone()
    }

    /// Bounded tail for the observation layer: cameras scan a window instead
    /// of cloning an ever-growing session log every few ticks.
    pub fn recent_events(&self, n: usize) -> Vec<SessionEvent> {
        let start = self.events.len().saturating_sub(n);
        self.events[start..].to_vec()
    }

    /// Every fact belonging to one work order, oldest first. The scan runs
    /// backwards and stops at the turn that opened the order, so deriving a
    /// context stays cheap even when the log has tens of thousands of events.
    pub fn task_events(&self, task_id: &str) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        for ev in self.events.iter().rev() {
            if ev.task_id.as_deref() == Some(task_id) {
                out.push(ev.clone());
                if ev.kind == "turn.started" {
                    break;
                }
            }
        }
        out.reverse();
        out
    }

    /// Most recent work order in the log — the default context to inspect.
    pub fn latest_task_id(&self) -> Option<String> {
        self.events.iter().rev().find_map(|e| e.task_id.clone())
    }

    pub fn threads(&self) -> Vec<ThreadInfo> {
        let mut v: Vec<ThreadInfo> = self.threads.values().cloned().collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    pub fn turns(&self) -> Vec<TurnInfo> {
        let mut v: Vec<TurnInfo> = self.turns.values().cloned().collect();
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        v
    }

    pub fn items(&self) -> Vec<ItemInfo> {
        let mut v: Vec<ItemInfo> = self.items.values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn thread(&self, id: &str) -> Option<ThreadInfo> {
        self.threads.get(id).cloned()
    }

    /// Fork a new thread from a prefix of the log — Codex's `thread/fork`,
    /// used here for "boss opens a side line to try another approach".
    pub fn fork(&mut self, from_thread: &str, at_seq: Option<u64>) -> anyhow::Result<ThreadInfo> {
        let cutoff = at_seq.unwrap_or(self.seq);
        let source: Vec<SessionEvent> = self
            .events
            .iter()
            .filter(|e| e.thread_id == from_thread && e.seq <= cutoff)
            .cloned()
            .collect();
        let new_id = format!("fork-{}", &short_id()[..6]);
        let info = self.create_thread(
            &new_id,
            &format!("支线 · 源自 {} @{}", from_thread, cutoff),
            Some(from_thread.into()),
        )?;
        for mut ev in source {
            ev.thread_id = new_id.clone();
            ev.ts = now_ms();
            self.append(ev)?;
        }
        Ok(info)
    }

    /// Ingest an event from an external agent runtime. Same log, same rules.
    pub fn ingest(&mut self, mut ev: SessionEvent) -> anyhow::Result<SessionEvent> {
        if ev.thread_id.is_empty() {
            ev.thread_id = "main".into();
        }
        if self.threads.get(&ev.thread_id).is_none() {
            self.create_thread(&ev.thread_id, &format!("外部接入 · {}", ev.thread_id), None)?;
        }
        self.append(ev)
    }
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn short_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}{:x}", n, std::process::id() as u128)
}

/// Convenience for tests / drivers.
pub fn temp_store() -> Mutex<SessionStore> {
    let dir = std::env::temp_dir().join(format!("medusa-test-{}", short_id()));
    Mutex::new(SessionStore::open(dir).expect("temp store"))
}
