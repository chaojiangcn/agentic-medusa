//! Configuration and credentials live in the local process, mirroring Codex's
//! `~/.codex/config.toml`. The API key is read from an environment variable
//! named by `env_key`; `config/read` returns only a boolean `hasApiKey`.

use crate::protocol::*;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub struct ConfigStore {
    pub path: PathBuf,
    pub home: PathBuf,
    inner: RwLock<AppConfig>,
}

impl ConfigStore {
    pub fn load(home: PathBuf) -> Result<Self> {
        fs::create_dir_all(&home)?;
        let path = home.join("medusa.toml");
        let cfg = if path.exists() {
            let text = fs::read_to_string(&path)?;
            toml::from_str::<AppConfig>(&text)
                .with_context(|| format!("parsing {}", path.display()))?
        } else {
            let default = AppConfig {
                mode: "mock".into(),
                model: "deepseek-chat".into(),
                model_provider: "deepseek".into(),
                providers: vec![ModelProvider {
                    id: "deepseek".into(),
                    name: "DeepSeek".into(),
                    base_url: "https://api.deepseek.com".into(),
                    model: "deepseek-chat".into(),
                    env_key: "DEEPSEEK_API_KEY".into(),
                    wire_api: "chat".into(),
                }],
                auto_demo: false,
                ..Default::default()
            };
            let text = toml::to_string_pretty(&default)?;
            fs::write(&path, text)?;
            default
        };
        Ok(Self {
            path,
            home,
            inner: RwLock::new(cfg),
        })
    }

    pub fn get(&self) -> AppConfig {
        self.inner.read().expect("config lock").clone()
    }

    pub fn view(&self) -> ConfigView {
        let c = self.get();
        let provider = c
            .providers
            .iter()
            .find(|p| p.id == c.model_provider)
            .cloned();
        let has_api_key = provider
            .as_ref()
            .map(|p| std::env::var(&p.env_key).map(|v| !v.is_empty()).unwrap_or(false))
            .unwrap_or(false);
        ConfigView {
            mode: c.mode,
            model: c.model,
            model_provider: c.model_provider,
            providers: c.providers,
            tick_ms: c.tick_ms,
            max_tokens_per_turn: c.max_tokens_per_turn,
            max_calls_per_minute: c.max_calls_per_minute,
            auto_demo: c.auto_demo,
            has_api_key,
            protocol_version: PROTOCOL_VERSION.into(),
            user_agent: USER_AGENT.into(),
            config_home: self.home.display().to_string(),
        }
    }

    /// Apply a partial update from the settings panel. Secrets are never
    /// accepted over the wire — only the env var name can be changed.
    pub fn update(&self, patch: serde_json::Value) -> Result<ConfigView> {
        let mut c = self.get();
        if let Some(v) = patch.get("mode").and_then(|v| v.as_str()) {
            c.mode = v.into();
        }
        if let Some(v) = patch.get("model").and_then(|v| v.as_str()) {
            c.model = v.into();
        }
        if let Some(v) = patch.get("modelProvider").and_then(|v| v.as_str()) {
            c.model_provider = v.into();
        }
        if let Some(v) = patch.get("tickMs").and_then(|v| v.as_u64()) {
            c.tick_ms = v.clamp(80, 5000);
        }
        if let Some(v) = patch.get("maxCallsPerMinute").and_then(|v| v.as_u64()) {
            c.max_calls_per_minute = v.clamp(1, 600) as u32;
        }
        if let Some(v) = patch.get("maxTokensPerTurn").and_then(|v| v.as_u64()) {
            c.max_tokens_per_turn = v.clamp(200, 100_000);
        }
        if let Some(v) = patch.get("autoDemo").and_then(|v| v.as_bool()) {
            c.auto_demo = v;
        }
        if let Some(arr) = patch.get("providers").and_then(|v| v.as_array()) {
            let mut providers = Vec::new();
            for item in arr {
                if let Ok(p) = serde_json::from_value::<ModelProvider>(item.clone()) {
                    // Strip anything that looks like a literal secret.
                    let mut p = p;
                    if p.env_key.starts_with("sk-") || p.env_key.len() > 64 {
                        p.env_key = format!("{}_API_KEY", p.id.to_uppercase().replace('-', "_"));
                    }
                    providers.push(p);
                }
            }
            if !providers.is_empty() {
                c.providers = providers;
            }
        }
        let text = toml::to_string_pretty(&c)?;
        fs::write(&self.path, text)?;
        *self.inner.write().expect("config lock") = c;
        Ok(self.view())
    }

    pub fn active_provider(&self) -> Option<ModelProvider> {
        let c = self.get();
        c.providers.into_iter().find(|p| p.id == c.model_provider)
    }

    pub fn api_key(&self) -> Option<String> {
        self.active_provider()
            .and_then(|p| std::env::var(&p.env_key).ok())
            .filter(|s| !s.is_empty())
    }

    pub fn is_live(&self) -> bool {
        self.get().mode == "live" && self.api_key().is_some()
    }
}

/// Where config + session logs live. Override with MEDUSA_HOME.
pub fn resolve_home() -> PathBuf {
    if let Ok(h) = std::env::var("MEDUSA_HOME") {
        return PathBuf::from(h);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Keep everything beside the binary, not in the user's C drive.
            return parent.join("medusa-home");
        }
    }
    Path::new(".").join("medusa-home")
}
