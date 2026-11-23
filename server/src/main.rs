//! Medusa App Server
//!
//! A single local process that hosts the runtime, owns the session log and
//! credentials, and exposes a bidirectional JSON-RPC 2.0 surface. The browser
//! is only a projection of it — closing the tab never stops the workshop.
//!
//!   medusa-app-server                       # ws://127.0.0.1:8787/rpc
//!   medusa-app-server --listen stdio://    # JSONL over stdin/stdout
//!   medusa-app-server --port 9000          # custom port
//!   MEDUSA_HOME=... medusa-app-server      # config + session log location

mod config;
mod llm;
mod protocol;
mod rpc;
mod session;
mod workshop;

use anyhow::Result;
use rpc::AppState;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let listen = arg_value(&args, "--listen").unwrap_or_else(|| "ws://127.0.0.1:8787".into());
    let port: u16 = arg_value(&args, "--port")
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);

    let home = config::resolve_home();
    println!("Medusa App Server {}", protocol::USER_AGENT);
    println!("  home      : {}", home.display());
    println!("  transport : {listen}");

    let config = config::ConfigStore::load(home.clone())?;
    let store = session::SessionStore::open(home.join("sessions"))?;
    let state = AppState::new(config, store);

    // The runtime driver runs inside this process, independent of any client.
    let driver_state = Arc::clone(&state);
    tokio::spawn(async move {
        workshop::run_driver(driver_state).await;
    });

    if listen.starts_with("stdio") {
        println!("  (JSONL on stdin/stdout; logs on stderr)",);
        return rpc::run_stdio(state).await;
    }

    let app = rpc::router(Arc::clone(&state));
    let addr = format!("127.0.0.1:{port}");
    println!("  rpc       : ws://{addr}/rpc");
    println!("  health    : http://{addr}/api/health");
    println!("  protocol  : http://{addr}/api/protocol");
    println!("  config    : {}", home.join("medusa.toml").display());
    println!("  mode      : {} (set MEDUSA_HOME/medusa.toml to switch)", state.config.get().mode);
    println!("  ready");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1).cloned())
}
