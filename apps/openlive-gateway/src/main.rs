mod config;
mod session;
mod session_state;
mod transport;

use std::sync::Arc;

use axum::{
    extract::{ws::WebSocketUpgrade, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use clap::Parser;
use openlive_provider::RealtimeProvider;
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::info;
use tracing_subscriber::EnvFilter;

use config::Args;

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn RealtimeProvider>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("openlive_gateway=info,tower_http=info")),
        )
        .init();

    let args = Args::parse();
    let provider = args.build_provider()?;
    let provider_id = provider.manifest().id;
    let state = AppState { provider };
    let static_files = ServeDir::new(&args.web_dir).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/providers", get(providers))
        .route("/v1/realtime", get(realtime))
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    info!(
        address = %args.listen,
        web_dir = %args.web_dir.display(),
        provider = %provider_id,
        "Openlive gateway listening"
    );
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn providers(State(state): State<AppState>) -> Json<openlive_protocol::ProviderManifest> {
    Json(state.provider.manifest())
}

async fn realtime(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(256 * 1_024)
        .max_frame_size(256 * 1_024)
        .on_upgrade(move |socket| session::run(socket, state.provider))
}
