#![recursion_limit = "256"]

mod config;
mod session;
mod session_registry;
mod session_state;
mod transport;
mod webrtc_media;
mod webrtc_session;

use std::{
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{ws::WebSocketUpgrade, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use openlive_protocol::PROTOCOL_REVISION;
use openlive_provider::{
    append_memory, clear_memory, clear_profile, correct_typos, ensure_sandbox, execute_approved,
    export_memory_json, export_profile_json, list_pending, llm_provider_catalog, load_profile,
    memory_file_path, piper_status, piper_synthesize, pool_job_status, pool_limits,
    preview_voice_pcm, profile_file_path, queue_write_file, reject_pending, sandbox_delete_file,
    sandbox_list_files, sandbox_read_file, sandbox_status, sandbox_write_file, set_display_name,
    AgentClass, AgentClient, AgentKind, AgentRequest, LlmBridge, LlmSettings, McpClient,
    MockDuplexProvider, PoolRequest, PoolTask, RealtimeProvider, DEFAULT_PIPER_VOICE,
    VOICE_PRESETS,
};
use openlive_runtime::SessionStore;
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use config::{provider_catalog, Args};
use session_registry::SessionRegistry;
use webrtc_media::WebRtcHub;

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn RealtimeProvider>,
    /// When voice uses the formant duplex path, this handle switches pitch/timbre.
    mock_voice: Option<MockDuplexProvider>,
    registry: Arc<SessionRegistry>,
    store: Option<SessionStore>,
    safety_enabled: bool,
    started: Instant,
    api_key: Option<String>,
    mcp: Option<Arc<McpClient>>,
    webrtc: Option<Arc<WebRtcHub>>,
    llm: Arc<LlmBridge>,
    agent: Arc<AgentClient>,
}

#[tokio::main]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("openlive_gateway=info,tower_http=info")),
        )
        .init();

    let args = Args::parse();
    session_state::set_default_task_deadline_ms(args.task_deadline_ms);

    let llm = Arc::new(LlmBridge::new().map_err(|e| e.to_string())?);
    // Seed from env if present (OPENLIVE_MODEL_API_KEY / NVIDIA_API_KEY).
    if let Ok(key) = std::env::var("OPENLIVE_MODEL_API_KEY")
        .or_else(|_| std::env::var("NVIDIA_API_KEY"))
        .or_else(|_| std::env::var("OPENLIVE_LLM_API_KEY"))
    {
        if !key.is_empty() {
            llm.patch_settings(|s| {
                s.api_key = Some(key);
            });
            info!("LLM API key loaded from environment");
        }
    }
    if let Ok(provider_id) = std::env::var("OPENLIVE_LLM_PROVIDER") {
        if !provider_id.is_empty() {
            let mut settings = LlmSettings::from_provider_id(&provider_id);
            settings.api_key = llm.settings().api_key;
            llm.update_settings(settings);
        }
    }

    let (provider, mock_voice) = args.build_provider(Some(llm.clone()))?;
    let provider_id = provider.manifest().id;
    let api_key = args.resolved_api_key();
    let api_key_required = api_key.is_some();

    let store = if args.no_persist {
        None
    } else {
        match SessionStore::open(&args.data_dir) {
            Ok(store) => {
                info!(path = %args.data_dir.display(), "session persistence enabled");
                Some(store)
            }
            Err(error) => {
                warn!(%error, "failed to open session store; persistence disabled");
                None
            }
        }
    };

    let mcp =
        args.mcp_url
            .as_ref()
            .and_then(|url| match McpClient::new(url.clone(), api_key.clone()) {
                Ok(client) => {
                    info!(%url, "MCP client configured");
                    Some(Arc::new(client))
                }
                Err(error) => {
                    warn!(%error, "invalid MCP url");
                    None
                }
            });

    let webrtc = match WebRtcHub::new() {
        Ok(hub) => {
            info!("gateway-native WebRTC hub ready");
            Some(Arc::new(hub))
        }
        Err(error) => {
            warn!(%error, "WebRTC hub unavailable");
            None
        }
    };

    let agent = Arc::new(AgentClient::new((*llm).clone()).map_err(|e| e.to_string())?);

    let state = AppState {
        provider,
        mock_voice,
        registry: Arc::new(SessionRegistry::new()),
        store,
        safety_enabled: args.safety,
        started: Instant::now(),
        api_key,
        mcp,
        webrtc,
        llm,
        agent,
    };
    let static_files = ServeDir::new(&args.web_dir).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/meta", get(meta))
        .route("/v1/providers", get(providers))
        .route("/v1/providers/catalog", get(providers_catalog))
        .route("/v1/llm/providers", get(llm_providers))
        .route("/v1/llm/config", get(llm_config_get).post(llm_config_set))
        .route("/v1/llm/models", post(llm_list_models))
        .route("/v1/llm/chat", post(llm_chat))
        .route("/v1/voices", get(list_voices))
        .route("/v1/voices/preview", post(voice_preview))
        .route("/v1/tts/status", get(tts_status))
        .route("/v1/tts/speak", post(tts_speak))
        .route("/v1/memory", get(memory_get).post(memory_post))
        .route("/v1/memory/export", get(memory_export))
        .route("/v1/memory/clear", post(memory_clear))
        .route("/v1/profile", get(profile_get).post(profile_post))
        .route("/v1/profile/export", get(profile_export))
        .route("/v1/profile/clear", post(profile_clear))
        .route("/v1/profile/facts/remove", post(profile_fact_remove))
        .route("/v1/profile/facts/update", post(profile_fact_update))
        .route("/v1/profile/facts/move", post(profile_fact_move))
        .route("/v1/profile/facts/reorder", post(profile_facts_reorder))
        .route("/v1/profile/facts/clear", post(profile_facts_clear))
        .route("/v1/typo/correct", post(typo_correct))
        .route("/v1/sandbox/status", get(sandbox_status_get))
        .route("/v1/sandbox/list", post(sandbox_list))
        .route("/v1/sandbox/read", post(sandbox_read))
        .route("/v1/sandbox/write", post(sandbox_write))
        .route("/v1/sandbox/delete", post(sandbox_delete))
        .route("/v1/sandbox/browse", post(sandbox_browse))
        .route("/v1/sandbox/screenshot", post(sandbox_screenshot))
        .route("/v1/sandbox/pdf", post(sandbox_pdf))
        .route("/v1/sandbox/media", get(sandbox_media_list))
        .route("/v1/sandbox/media/read", post(sandbox_media_read))
        .route("/v1/sandbox/browser/status", get(sandbox_browser_status))
        .route("/v1/sandbox/lab", get(sandbox_lab))
        .route("/v1/sandbox/test/run", post(sandbox_test_run))
        .route("/v1/sessions", get(list_sessions))
        .route("/v1/sessions/{id}/tasks", get(session_tasks))
        .route("/v1/sessions/{id}/events", get(session_events))
        .route("/v1/sessions/{id}/transcript", get(session_transcript))
        .route("/v1/realtime", get(realtime))
        .route("/v1/realtime/session", post(realtime_session))
        .route("/v1/webrtc/ice", get(webrtc_ice))
        .route("/v1/webrtc/offer", post(webrtc_offer))
        .route("/v1/tasks", post(create_task_hint))
        .route("/v1/mcp/tools", get(mcp_tools))
        .route("/v1/mcp/call", post(mcp_call))
        .route("/v1/agent/run", post(agent_run))
        .route("/v1/agent/probe", post(agent_probe))
        .route("/v1/agent/pool", post(agent_pool_run))
        .route("/v1/agent/pool/start", post(agent_pool_start))
        .route("/v1/agent/pool/status", get(agent_pool_status))
        .route("/v1/agent/pool/events", get(agent_pool_events))
        .route("/v1/agent/confirm", post(agent_confirm))
        .route("/v1/agent/pending", get(agent_pending_list))
        .route("/v1/agent/classes", get(agent_classes))
        .route("/v1/agent/session/stats", get(agent_session_stats))
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    info!(
        address = %args.listen,
        web_dir = %args.web_dir.display(),
        provider = %provider_id,
        task_deadline_ms = args.task_deadline_ms,
        api_key_required,
        safety = args.safety,
        "Openlive gateway listening"
    );
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_ms": u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "active_sessions": state.registry.active_count(),
        "provider": state.provider.manifest().id,
        "persistence": state.store.is_some(),
        "safety": state.safety_enabled,
        "mcp": state.mcp.is_some(),
        "webrtc_peers": state.webrtc.as_ref().map_or(0, |h| h.peer_count()),
        "gateway_webrtc": state.webrtc.is_some(),
    }))
}

async fn meta(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": "openlive-gateway",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": openlive_protocol::PROTOCOL_VERSION,
        "protocol_revision": PROTOCOL_REVISION,
        "provider": state.provider.manifest().id,
        "provider_class": state.provider.manifest().provider_class,
        "active_sessions": state.registry.active_count(),
        "sessions_opened_total": state.registry.opened_total(),
        "uptime_ms": u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "server_time_ms": now_ms(),
        "persistence": state.store.is_some(),
        "safety": state.safety_enabled,
        "mcp": state.mcp.is_some(),
        "gateway_webrtc": state.webrtc.is_some(),
        "endpoints": {
            "health": "GET /health",
            "meta": "GET /v1/meta",
            "providers": "GET /v1/providers",
            "providers_catalog": "GET /v1/providers/catalog",
            "sessions": "GET /v1/sessions",
            "session_tasks": "GET /v1/sessions/{id}/tasks",
            "session_events": "GET /v1/sessions/{id}/events",
            "session_transcript": "GET /v1/sessions/{id}/transcript",
            "realtime_ws": "GET /v1/realtime",
            "realtime_session": "POST /v1/realtime/session",
            "webrtc_ice": "GET /v1/webrtc/ice",
            "webrtc_offer": "POST /v1/webrtc/offer",
            "tasks_hint": "POST /v1/tasks",
            "mcp_tools": "GET /v1/mcp/tools",
            "mcp_call": "POST /v1/mcp/call",
            "agent_run": "POST /v1/agent/run",
            "agent_probe": "POST /v1/agent/probe",
            "agent_pool": "POST /v1/agent/pool",
            "tts_status": "GET /v1/tts/status",
            "tts_speak": "POST /v1/tts/speak",
            "memory": "GET|POST /v1/memory",
            "memory_export": "GET /v1/memory/export",
            "typo_correct": "POST /v1/typo/correct",
            "sandbox_status": "GET /v1/sandbox/status",
            "sandbox_list": "POST /v1/sandbox/list",
            "sandbox_read": "POST /v1/sandbox/read",
            "sandbox_write": "POST /v1/sandbox/write"
        },
        "features": feature_flags(&state),
        "piper": piper_status(DEFAULT_PIPER_VOICE),
        "agent_pool": pool_limits(),
    }))
}

async fn tts_status() -> Json<serde_json::Value> {
    let st = piper_status(DEFAULT_PIPER_VOICE);
    Json(serde_json::json!({
        "piper": st,
        "fallback": "formant",
        "browser_tts": "optional client-side",
        "preferred": if st.available { "piper" } else { "formant" },
    }))
}

async fn tts_speak(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let text = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text is required" })),
        )
            .into_response();
    }
    let voice_id = body
        .get("voice_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(DEFAULT_PIPER_VOICE);
    let prefer = body
        .get("engine")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("auto");

    // Prefer Piper when installed; otherwise formant.
    if prefer != "formant" {
        match piper_synthesize(text, voice_id) {
            Ok((pcm, rate)) => {
                return (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "engine": "piper",
                        "voice_id": voice_id,
                        "sample_rate": rate,
                        "channels": 1,
                        "format": "s16le",
                        "pcm_base64": base64_encode(&pcm),
                        "bytes": pcm.len(),
                    })),
                )
                    .into_response();
            }
            Err(e) => {
                if prefer == "piper" {
                    let st = piper_status(voice_id);
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({
                            "error": e,
                            "piper": st,
                            "hint": "Copy install_command_windows or install_command_unix from /v1/tts/status",
                        })),
                    )
                        .into_response();
                }
                // fall through to formant
            }
        }
    }

    let sample_rate = 24_000u32;
    let pcm = preview_voice_pcm(voice_id, text, sample_rate);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "engine": "formant",
            "voice_id": voice_id,
            "sample_rate": sample_rate,
            "channels": 1,
            "format": "s16le",
            "pcm_base64": base64_encode(&pcm),
            "bytes": pcm.len(),
            "note": "Using formant fallback. Install Piper for higher quality open-source neural TTS.",
            "piper": piper_status(DEFAULT_PIPER_VOICE),
        })),
    )
        .into_response()
}

async fn memory_get() -> impl IntoResponse {
    let doc = openlive_provider::load_memory();
    Json(serde_json::json!({
        "path": memory_file_path(),
        "count": doc.entries.len(),
        "entries": doc.entries,
    }))
    .into_response()
}

async fn memory_post(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let role = body
        .get("role")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("user");
    let text = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text required" })),
        )
            .into_response();
    }
    let tags = body
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    match append_memory(role, text, tags) {
        Ok(doc) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "count": doc.entries.len(),
                "path": memory_file_path(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn memory_export() -> impl IntoResponse {
    match export_memory_json() {
        Ok(v) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "path": memory_file_path(),
                "memory": v,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn memory_clear() -> impl IntoResponse {
    match clear_memory() {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_get() -> impl IntoResponse {
    let p = load_profile();
    Json(serde_json::json!({
        "path": profile_file_path(),
        "profile": p,
        "setup_hints": openlive_provider::profile_setup_hints(),
    }))
    .into_response()
}

async fn profile_post(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    match openlive_provider::patch_profile(&body) {
        Ok(p) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "profile": p,
                "setup_hints": openlive_provider::profile_setup_hints(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_export() -> impl IntoResponse {
    match export_profile_json() {
        Ok(v) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "path": profile_file_path(),
                "profile": v,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_clear() -> impl IntoResponse {
    match clear_profile() {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_fact_remove(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    if let Some(idx) = body
        .get("index")
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
    {
        return match openlive_provider::profile_remove_fact_at(idx) {
            Ok(p) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "profile": p })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response(),
        };
    }
    if let Some(fact) = body
        .get("fact")
        .or_else(|| body.get("text"))
        .and_then(serde_json::Value::as_str)
    {
        return match openlive_provider::profile_remove_fact_text(fact) {
            Ok(p) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "profile": p })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response(),
        };
    }
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": "provide index or fact" })),
    )
        .into_response()
}

async fn profile_facts_clear() -> impl IntoResponse {
    match openlive_provider::profile_clear_facts() {
        Ok(p) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "profile": p })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_fact_update(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let index = body
        .get("index")
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let fact = body
        .get("fact")
        .or_else(|| body.get("text"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let Some(index) = index else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "index is required" })),
        )
            .into_response();
    };
    if fact.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "fact is required" })),
        )
            .into_response();
    }
    match openlive_provider::profile_update_fact_at(index, fact) {
        Ok(p) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "profile": p })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_fact_move(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let from = body
        .get("from")
        .or_else(|| body.get("index"))
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let to = body
        .get("to")
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    // Convenience: direction "up" | "down" from index
    let (from, to) = if let (Some(from), Some(to)) = (from, to) {
        (from, to)
    } else if let Some(from) = from {
        let dir = body
            .get("direction")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let to = match dir {
            "up" => from.saturating_sub(1),
            "down" => from + 1,
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "provide from+to or from+direction(up|down)"
                    })),
                )
                    .into_response();
            }
        };
        (from, to)
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "provide from+to or from+direction(up|down)"
            })),
        )
            .into_response();
    };
    match openlive_provider::profile_move_fact(from, to) {
        Ok(p) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "profile": p })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn profile_facts_reorder(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let order = body
        .get("order")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().and_then(|n| usize::try_from(n).ok()))
                .collect::<Vec<_>>()
        });
    let Some(order) = order else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "order array is required" })),
        )
            .into_response();
    };
    match openlive_provider::profile_reorder_facts(&order) {
        Ok(p) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "profile": p })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn typo_correct(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let text = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let corrected = correct_typos(text);
    Json(serde_json::json!({
        "original": text,
        "corrected": corrected,
        "changed": corrected != text,
    }))
    .into_response()
}

async fn sandbox_status_get() -> impl IntoResponse {
    let _ = ensure_sandbox();
    Json(serde_json::json!({ "sandbox": sandbox_status() })).into_response()
}

async fn sandbox_list(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let path = body
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match sandbox_list_files(path) {
        Ok(files) => (
            StatusCode::OK,
            Json(serde_json::json!({ "path": path, "files": files })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn sandbox_read(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let path = body
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match sandbox_read_file(path) {
        Ok(text) => (
            StatusCode::OK,
            Json(serde_json::json!({ "path": path, "text": text })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn sandbox_write(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let path = body
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let content = body
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match sandbox_write_file(path, content) {
        Ok(msg) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "message": msg })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn sandbox_delete(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let path = body
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match sandbox_delete_file(path) {
        Ok(msg) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "message": msg })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn sandbox_browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let url = body
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "url is required" })),
        )
            .into_response();
    }
    let engine = body
        .get("engine")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("auto");
    // Prefer agent path for auto/http; headless goes through tools module.
    let result = if engine.eq_ignore_ascii_case("headless")
        || engine.eq_ignore_ascii_case("chrome")
        || engine.eq_ignore_ascii_case("edge")
    {
        let url = url.to_owned();
        tokio::task::spawn_blocking(move || openlive_provider::headless_browse(&url))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map(|(text, cite, _)| (text, cite, "headless".to_string()))
    } else {
        state
            .agent
            .browse_page(url)
            .await
            .map(|(text, cite)| (text, cite, "auto".to_string()))
    };
    match result {
        Ok((text, cite, eng)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "engine": eng,
                "text": text,
                "source": cite,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": e,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
    }
}

async fn sandbox_browser_status() -> impl IntoResponse {
    Json(serde_json::json!({
        "browser": openlive_provider::headless_browser_status(),
        "engines": ["auto", "http", "headless"],
        "features": ["dump_dom", "screenshot", "pdf"],
        "note": "headless uses installed Chrome/Edge --dump-dom / --screenshot / --print-to-pdf; set OPENLIVE_BROWSER to override path",
    }))
    .into_response()
}

async fn sandbox_pdf(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let url = body
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "url is required" })),
        )
            .into_response();
    }
    let url = url.to_owned();
    match tokio::task::spawn_blocking(move || openlive_provider::headless_pdf(&url)).await {
        Ok(Ok(pdf)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "pdf": pdf,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": e,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn sandbox_media_list() -> impl IntoResponse {
    let items = openlive_provider::list_lab_media(40);
    Json(serde_json::json!({
        "count": items.len(),
        "items": items,
    }))
    .into_response()
}

async fn sandbox_media_read(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let path = body
        .get("path")
        .or_else(|| body.get("relative_path"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "path is required" })),
        )
            .into_response();
    }
    match openlive_provider::read_lab_media_base64(path) {
        Ok((b64, mime, bytes)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "path": path,
                "mime": mime,
                "bytes": bytes,
                "base64": b64,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn sandbox_screenshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let url = body
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "url is required" })),
        )
            .into_response();
    }
    let width = body
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(1280);
    let height = body
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(800);
    let url = url.to_owned();
    match tokio::task::spawn_blocking(move || {
        openlive_provider::headless_screenshot(&url, width, height)
    })
    .await
    {
        Ok(Ok(shot)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "screenshot": shot,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": e,
                "browser": openlive_provider::headless_browser_status(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn agent_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    // Apply optional LLM overrides from the client before running.
    apply_llm_body(&state, &body);
    let intent = body
        .get("intent")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let kind = AgentKind::parse(
        body.get("agent_kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("internal"),
    );
    let request = AgentRequest {
        kind,
        intent,
        base_url: body
            .get("base_url")
            .or_else(|| body.get("agent_base_url"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        api_key: body
            .get("api_key")
            .or_else(|| body.get("agent_api_key"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.is_empty()),
        model: body
            .get("model")
            .or_else(|| body.get("agent_model"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        thought_depth: body
            .get("thought_depth")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        agent_class: body
            .get("agent_class")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        session_id: body
            .get("session_id")
            .or_else(|| body.get("session_hint"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        prior_context: body
            .get("prior_context")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    };
    let result = state.agent.run(request).await;
    let status = if result.status == "completed"
        || result.status == "skipped"
        || result.status == "needs_confirm"
    {
        StatusCode::OK
    } else if let Some(ms) = result.model_status {
        StatusCode::from_u16(ms).unwrap_or(StatusCode::BAD_GATEWAY)
    } else {
        StatusCode::BAD_GATEWAY
    };
    let mut body = serde_json::to_value(&result).unwrap_or_default();
    if let Some(obj) = body.as_object_mut() {
        obj.insert("http_status".into(), serde_json::json!(status.as_u16()));
    }
    (status, Json(body)).into_response()
}

async fn agent_confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let id = body
        .get("id")
        .or_else(|| body.get("pending_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "id is required" })),
        )
            .into_response();
    }
    let approve = body
        .get("approve")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !approve {
        return match reject_pending(id) {
            Ok(()) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "approved": false, "message": "cancelled" })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response(),
        };
    }
    match execute_approved(id) {
        Ok(msg) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "approved": true, "message": msg })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn agent_pending_list() -> impl IntoResponse {
    Json(serde_json::json!({ "pending": list_pending() })).into_response()
}

async fn agent_pool_status(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let id = q.get("id").map_or("", String::as_str).trim();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "id query param required" })),
        )
            .into_response();
    }
    match pool_job_status(id) {
        Some(st) => (
            StatusCode::OK,
            Json(serde_json::to_value(st).unwrap_or_default()),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "pool job not found" })),
        )
            .into_response(),
    }
}

/// Server-Sent Events stream of pool progress until completed/error or timeout.
async fn agent_pool_events(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::stream;
    use std::convert::Infallible;
    use std::time::Duration;

    let id = q.get("id").cloned().unwrap_or_default().trim().to_owned();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "id query param required" })),
        )
            .into_response();
    }

    let stream = stream::unfold((id, 0u32), |(id, tick)| async move {
        if tick > 150 {
            // ~30s at 200ms
            return None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        match pool_job_status(&id) {
            Some(st) => {
                let done = st.status == "completed" || st.status == "error";
                let data = serde_json::to_string(&st).unwrap_or_else(|_| "{}".into());
                let ev = Event::default().event("pool").data(data);
                if done {
                    Some((Ok::<_, Infallible>(ev), (id, 9999)))
                } else {
                    Some((Ok(ev), (id, tick + 1)))
                }
            }
            None if tick == 0 => {
                let ev = Event::default()
                    .event("error")
                    .data(r#"{"error":"pool job not found"}"#);
                Some((Ok(ev), (id, 9999)))
            }
            None => None,
        }
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(2)))
        .into_response()
}

async fn agent_classes() -> impl IntoResponse {
    Json(serde_json::json!({
        "classes": AgentClass::catalog(),
        "default": "general",
    }))
    .into_response()
}

async fn agent_session_stats() -> impl IntoResponse {
    Json(serde_json::json!({
        "session_context": openlive_provider::session_stats(),
    }))
    .into_response()
}

async fn sandbox_lab() -> impl IntoResponse {
    let _ = ensure_sandbox();
    let st = sandbox_status();
    Json(serde_json::json!({
        "lab": {
            "root": st.root,
            "workspace": st.workspace,
            "dirs": ["workspace", "lab", "test"],
            "note": "Lab is a constrained sandbox for agent experiments. Use /v1/sandbox/test/run for self-tests.",
        },
        "sandbox": st,
    }))
    .into_response()
}

#[allow(clippy::too_many_lines)]
async fn sandbox_test_run(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let mut tests = Vec::new();
    // 1. Sandbox write/read
    let path = "test/self-test.txt";
    let write = sandbox_write_file(path, "openlive-ok");
    let read = sandbox_read_file(path);
    tests.push(serde_json::json!({
        "name": "sandbox_write_read",
        "ok": write.is_ok() && read.as_ref().map(|t| t.contains("openlive-ok")).unwrap_or(false),
        "detail": format!("{:?} / {:?}", write, read.as_ref().map(|s| s.chars().take(40).collect::<String>())),
    }));
    // 2. Calculator / identity via agent
    let calc = state
        .agent
        .run(AgentRequest {
            kind: AgentKind::Internal,
            intent: "calculate 12+30".into(),
            base_url: None,
            api_key: None,
            model: None,
            thought_depth: Some("voice".into()),
            agent_class: Some("safe".into()),
            session_id: Some("self-test".into()),
            prior_context: None,
        })
        .await;
    tests.push(serde_json::json!({
        "name": "agent_calculator",
        "ok": calc.status == "completed" && calc.result.as_deref().unwrap_or("").contains("42"),
        "detail": calc.result,
    }));
    let idn = state
        .agent
        .run(AgentRequest {
            kind: AgentKind::Internal,
            intent: "who are you".into(),
            base_url: None,
            api_key: None,
            model: None,
            thought_depth: Some("voice".into()),
            agent_class: Some("general".into()),
            session_id: Some("self-test".into()),
            prior_context: None,
        })
        .await;
    tests.push(serde_json::json!({
        "name": "agent_identity",
        "ok": idn.status == "completed" && idn.result.as_deref().unwrap_or("").contains("OpenLive"),
        "detail": idn.result,
    }));
    // 3. TTS formant path
    let pcm = preview_voice_pcm("en_US-lessac-medium", "test", 24_000);
    tests.push(serde_json::json!({
        "name": "formant_tts",
        "ok": !pcm.is_empty(),
        "detail": format!("{} bytes", pcm.len()),
    }));
    // 4. Pending confirm overwrite flow
    let cpath = "test/confirm-demo.txt";
    let _ = sandbox_write_file(cpath, "v1");
    let pend = queue_write_file(cpath, "v2-approved", "self-test overwrite");
    let approved = execute_approved(&pend.id);
    let after = sandbox_read_file(cpath);
    tests.push(serde_json::json!({
        "name": "pending_confirm_write",
        "ok": approved.is_ok() && after.as_ref().map(|t| t.contains("v2-approved")).unwrap_or(false),
        "detail": format!("{:?} / {:?}", approved, after),
    }));
    // 5. Lab note + browse wiki summary
    let note = openlive_provider::save_lab_note("self-test", "# OpenLive self-test\nok");
    tests.push(serde_json::json!({
        "name": "save_lab_note",
        "ok": note.is_ok(),
        "detail": note.as_ref().ok().cloned().unwrap_or_else(|| note.err().unwrap_or_default()),
    }));
    let browse = state
        .agent
        .browse_page("https://en.wikipedia.org/wiki/Intelligent_agent")
        .await;
    tests.push(serde_json::json!({
        "name": "browse_wikipedia",
        "ok": browse.as_ref().map(|(t, _)| t.to_ascii_lowercase().contains("agent")).unwrap_or(false),
        "detail": browse.as_ref().map_or_else(std::clone::Clone::clone, |(t, c)| format!("{} @ {}", t.chars().take(80).collect::<String>(), c.url)),
    }));
    // 6. Durable profile
    let pname = set_display_name("SelfTestUser");
    let loaded = load_profile();
    tests.push(serde_json::json!({
        "name": "user_profile",
        "ok": pname.is_ok() && loaded.display_name.as_deref() == Some("SelfTestUser"),
        "detail": loaded.display_name,
    }));
    let _ = clear_profile();

    // 7. Async pool start
    let started = state.agent.start_pool_job(
        PoolRequest {
            intent: "AI agent".into(),
            tasks: vec![],
            max_agents: Some(2),
            thought_depth: Some("deep".into()),
        },
        false,
    );
    // Wait briefly for workers
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let st = pool_job_status(&started.pool_id);
    tests.push(serde_json::json!({
        "name": "pool_start_async",
        "ok": st.as_ref().is_some_and(|s| s.completed > 0 || s.status == "completed"),
        "detail": st.map(|s| format!("{} {}/{}", s.status, s.completed, s.total)),
    }));
    let passed = tests
        .iter()
        .filter(|t| t["ok"].as_bool() == Some(true))
        .count();
    let total = tests.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": passed == total,
            "passed": passed,
            "total": total,
            "tests": tests,
        })),
    )
        .into_response()
}

async fn agent_pool_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    apply_llm_body(&state, &body);
    let intent = body
        .get("intent")
        .or_else(|| body.get("query"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if intent.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "intent is required" })),
        )
            .into_response();
    }
    let max_agents = body
        .get("max_agents")
        .or_else(|| body.get("agents"))
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let use_llm = body
        .get("use_llm")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let thought_depth = body
        .get("thought_depth")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let tasks = body
        .get("tasks")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let intent = v
                        .get("intent")
                        .or_else(|| v.as_str().map(|_| v))
                        .and_then(|x| x.as_str())
                        .or_else(|| v.as_str())?
                        .to_owned();
                    Some(PoolTask {
                        intent,
                        thought_depth: thought_depth.clone(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Tracked pool so clients can poll /v1/agent/pool/status?id=
    let pool = state
        .agent
        .run_pool_tracked(
            PoolRequest {
                intent,
                tasks,
                max_agents,
                thought_depth,
            },
            use_llm,
        )
        .await;
    let status = if pool.status == "completed" {
        StatusCode::OK
    } else {
        StatusCode::BAD_GATEWAY
    };
    (status, Json(serde_json::to_value(pool).unwrap_or_default())).into_response()
}

/// Fire-and-forget pool: returns `pool_id` immediately for SSE/status polling.
async fn agent_pool_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    apply_llm_body(&state, &body);
    let intent = body
        .get("intent")
        .or_else(|| body.get("query"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if intent.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "intent is required" })),
        )
            .into_response();
    }
    let max_agents = body
        .get("max_agents")
        .or_else(|| body.get("agents"))
        .and_then(serde_json::Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let use_llm = body
        .get("use_llm")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let thought_depth = body
        .get("thought_depth")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let st = state.agent.start_pool_job(
        PoolRequest {
            intent,
            tasks: vec![],
            max_agents,
            thought_depth,
        },
        use_llm,
    );
    (
        StatusCode::OK,
        Json(serde_json::to_value(st).unwrap_or_default()),
    )
        .into_response()
}

async fn agent_probe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    apply_llm_body(&state, &body);
    let kind = AgentKind::parse(
        body.get("agent_kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("internal"),
    );
    let result = state.agent.probe(kind).await;
    let ok = result.status == "ok" || result.status == "disabled";
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::BAD_GATEWAY
        },
        Json(serde_json::json!({
            "ok": ok,
            "status": result.status,
            "detail": result.result,
            "error": result.error,
            "agent_kind": result.agent_kind,
            "tools": [
                "web_search",
                "deep_search",
                "research_pool",
                "browse_url",
                "get_time",
                "calculator",
                "list_files",
                "read_file",
                "write_file"
            ],
            "agent_pool": pool_limits(),
        })),
    )
        .into_response()
}

async fn llm_providers() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "providers": llm_provider_catalog(),
        "note": "NVIDIA NIM offers free keys at build.nvidia.com. Custom expects an OpenAI-compatible /v1 base URL."
    }))
}

async fn llm_config_get(State(state): State<AppState>) -> Json<serde_json::Value> {
    let s = state.llm.settings();
    Json(serde_json::json!({
        "provider_id": s.provider_id,
        "base_url": s.base_url,
        "model": s.model,
        "has_api_key": s.api_key.as_ref().is_some_and(|k| !k.is_empty()),
        "can_chat": s.can_chat(),
        "system_prompt": s.system_prompt,
        "voice": state.mock_voice.as_ref().map(MockDuplexProvider::voice),
    }))
}

async fn llm_config_set(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    apply_llm_body(&state, &body);
    if let Some(voice) = body.get("voice_id").and_then(serde_json::Value::as_str) {
        if let Some(mock) = &state.mock_voice {
            mock.set_voice(voice);
        }
    }
    let s = state.llm.settings();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "provider_id": s.provider_id,
            "base_url": s.base_url,
            "model": s.model,
            "has_api_key": s.api_key.as_ref().is_some_and(|k| !k.is_empty()),
            "can_chat": s.can_chat(),
            "voice": state.mock_voice.as_ref().map(MockDuplexProvider::voice),
        })),
    )
        .into_response()
}

async fn llm_list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let base = body.get("base_url").and_then(serde_json::Value::as_str);
    let key = body.get("api_key").and_then(serde_json::Value::as_str);
    match state.llm.list_models(base, key).await {
        Ok(models) => (
            StatusCode::OK,
            Json(serde_json::json!({ "models": models, "count": models.len() })),
        )
            .into_response(),
        Err(e) => {
            let code = e.status_code();
            let status = if code > 0 {
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY)
            } else {
                StatusCode::BAD_GATEWAY
            };
            (
                status,
                Json(serde_json::json!({
                    "error": e.to_string(),
                    "models": [],
                    "model_status": code,
                    "http_status": status.as_u16(),
                })),
            )
                .into_response()
        }
    }
}

async fn llm_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    apply_llm_body(&state, &body);
    let text = body
        .get("text")
        .or_else(|| body.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text is required" })),
        )
            .into_response();
    }
    match state.llm.chat(text).await {
        Ok(reply) => (StatusCode::OK, Json(serde_json::json!({ "text": reply }))).into_response(),
        Err(e) => {
            let code = e.status_code();
            let status = if code > 0 {
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY)
            } else {
                StatusCode::BAD_GATEWAY
            };
            (
                status,
                Json(serde_json::json!({
                    "error": e.to_string(),
                    "model_status": code,
                    "http_status": status.as_u16(),
                })),
            )
                .into_response()
        }
    }
}

async fn list_voices(State(state): State<AppState>) -> Json<serde_json::Value> {
    let active = state
        .mock_voice
        .as_ref()
        .map_or_else(|| "en_US-lessac-medium".into(), MockDuplexProvider::voice);
    let voices: Vec<_> = VOICE_PRESETS
        .iter()
        .map(|(id, name, f0)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "f0": f0,
                "family": "formant",
                "previewable": true,
            })
        })
        .collect();
    let piper = piper_status(DEFAULT_PIPER_VOICE);
    Json(serde_json::json!({
        "voices": voices,
        "active": active,
        "engine": if piper.available { "piper+formant" } else { "openlive-formant" },
        "piper": piper,
        "note": "Prefer open-source Piper when installed; formant is always available offline."
    }))
}

async fn voice_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let voice_id = body
        .get("voice_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("en_US-lessac-medium");
    let text = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let sample_rate = 24_000u32;
    let pcm = preview_voice_pcm(voice_id, text, sample_rate);
    // Also switch active voice when previewing.
    if let Some(mock) = &state.mock_voice {
        mock.set_voice(voice_id);
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "voice_id": voice_id,
            "sample_rate": sample_rate,
            "channels": 1,
            "format": "s16le",
            "pcm_base64": base64_encode(&pcm),
            "bytes": pcm.len(),
        })),
    )
        .into_response()
}

fn apply_llm_body(state: &AppState, body: &serde_json::Value) {
    let mut s = state.llm.settings();
    if let Some(pid) = body
        .get("provider_id")
        .or_else(|| body.get("llm_provider"))
        .and_then(serde_json::Value::as_str)
    {
        if !pid.is_empty() && pid != s.provider_id {
            let key = s.api_key.clone();
            s = LlmSettings::from_provider_id(pid);
            s.api_key = key;
        }
    }
    if let Some(url) = body
        .get("base_url")
        .or_else(|| body.get("model_base_url"))
        .and_then(serde_json::Value::as_str)
    {
        if !url.is_empty() {
            url.clone_into(&mut s.base_url);
        }
    }
    if let Some(model) = body
        .get("model")
        .or_else(|| body.get("llm_model"))
        .and_then(serde_json::Value::as_str)
    {
        if !model.is_empty() {
            model.clone_into(&mut s.model);
        }
    }
    if let Some(key) = body
        .get("api_key")
        .or_else(|| body.get("model_api_key"))
        .and_then(serde_json::Value::as_str)
    {
        s.api_key = if key.is_empty() {
            None
        } else {
            Some(key.to_owned())
        };
    }
    if let Some(sys) = body
        .get("system_prompt")
        .and_then(serde_json::Value::as_str)
    {
        if !sys.is_empty() {
            sys.clone_into(&mut s.system_prompt);
        }
    }
    state.llm.update_settings(s);
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

async fn list_sessions(State(state): State<AppState>) -> Json<serde_json::Value> {
    let active: Vec<_> = state
        .registry
        .list()
        .iter()
        .map(session_registry::SessionInfo::to_json)
        .collect();
    let persisted = state
        .store
        .as_ref()
        .and_then(|store| store.list_session_ids().ok())
        .unwrap_or_default();
    Json(serde_json::json!({
        "active": active,
        "count": state.registry.active_count(),
        "opened_total": state.registry.opened_total(),
        "persisted_session_ids": persisted,
    }))
}

async fn session_tasks(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let Ok(session_id) = uuid::Uuid::parse_str(&id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid session id" })),
        )
            .into_response();
    };
    let Some(store) = &state.store else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "persistence disabled" })),
        )
            .into_response();
    };
    match store.list_tasks(session_id) {
        Ok(tasks) => {
            Json(serde_json::json!({ "session_id": session_id, "tasks": tasks })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn session_events(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let Ok(session_id) = uuid::Uuid::parse_str(&id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid session id" })),
        )
            .into_response();
    };
    let after = query
        .get("after")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let Some(store) = &state.store else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "persistence disabled" })),
        )
            .into_response();
    };
    match store.load_envelopes_after(session_id, after) {
        Ok(events) => {
            let rows: Vec<_> = events
                .into_iter()
                .map(|row| {
                    serde_json::json!({
                        "sequence": row.sequence,
                        "event_id": row.event_id,
                        "recorded_at_ms": row.recorded_at_ms,
                        "envelope": serde_json::from_str::<serde_json::Value>(&row.envelope_json)
                            .unwrap_or(serde_json::Value::String(row.envelope_json)),
                    })
                })
                .collect();
            Json(serde_json::json!({
                "session_id": session_id,
                "after": after,
                "events": rows,
            }))
            .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn session_transcript(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let Ok(session_id) = uuid::Uuid::parse_str(&id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid session id" })),
        )
            .into_response();
    };
    let Some(store) = &state.store else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "persistence disabled" })),
        )
            .into_response();
    };
    match store.load_envelopes_after(session_id, 0) {
        Ok(events) => {
            let mut turns = Vec::new();
            for row in events {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&row.envelope_json)
                else {
                    continue;
                };
                let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let payload = value
                    .get("payload")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                match event_type {
                    "output_text_final" => {
                        if let Some(text) = payload.get("text").and_then(|t| t.as_str()) {
                            turns.push(serde_json::json!({
                                "role": "assistant",
                                "text": text,
                                "sequence": row.sequence,
                                "event_id": row.event_id,
                            }));
                        }
                    }
                    "user_transcript_delta" => {
                        if payload
                            .get("is_final")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                        {
                            if let Some(text) = payload.get("text").and_then(|t| t.as_str()) {
                                turns.push(serde_json::json!({
                                    "role": "user",
                                    "text": text,
                                    "sequence": row.sequence,
                                    "event_id": row.event_id,
                                }));
                            }
                        }
                    }
                    _ => {}
                }
            }
            Json(serde_json::json!({
                "session_id": session_id,
                "turns": turns,
                "format": "openlive.transcript.v1"
            }))
            .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn webrtc_ice() -> Json<serde_json::Value> {
    // Public STUN only — operators should inject TURN via reverse proxy config.
    Json(serde_json::json!({
        "iceServers": ice_servers(),
        "note": "Browser WebRTC to provider edges uses these STUN servers; gateway-native DTLS/SRTP is not yet enabled."
    }))
}

/// Accept a browser SDP offer.
///
/// Prefer **gateway-native** WebRTC (DTLS data channels for events + PCM) when
/// the hub is available. Falls back to provider-edge client secrets for
/// OpenAI-compatible Realtime SDP exchange.
async fn webrtc_offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let sdp = body
        .get("sdp")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if sdp.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "sdp is required" })),
        )
            .into_response();
    }
    let offer_type = body
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("offer");
    if offer_type != "offer" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "type must be offer" })),
        )
            .into_response();
    }

    let prefer_gateway = body
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|m| m == "gateway" || m == "gateway_native");

    if prefer_gateway {
        if let Some(hub) = &state.webrtc {
            match hub.accept_offer(sdp).await {
                Ok((answer_sdp, peer)) => {
                    let session_id = peer.id;
                    let provider = state.provider.clone();
                    tokio::spawn(async move {
                        webrtc_session::run_webrtc_peer(peer, provider).await;
                    });
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "session_id": session_id,
                            "mode": "gateway_native",
                            "type": "answer",
                            "sdp": answer_sdp,
                            "iceServers": ice_servers(),
                            "channels": ["openlive-events", "openlive-media"],
                            "note": "DTLS data channels carry control JSON + PCM media packets."
                        })),
                    )
                        .into_response();
                }
                Err(error) => {
                    warn!(%error, "gateway webrtc answer failed; trying provider edge");
                }
            }
        }
    }

    let secret = state.provider.create_client_secret().await.ok().flatten();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "session_id": uuid::Uuid::new_v4(),
            "mode": if secret.is_some() { "provider_edge" } else { "signaling_only" },
            "iceServers": ice_servers(),
            "client_secret": secret.map(|value| serde_json::json!({ "value": value })),
            "type": "answer",
            "sdp": serde_json::Value::Null,
            "note": "No gateway-native answer; use client_secret with provider Realtime SDP or WebSocket PCM.",
        })),
    )
        .into_response()
}

fn ice_servers() -> serde_json::Value {
    serde_json::json!([
        { "urls": ["stun:stun.l.google.com:19302"] },
        { "urls": ["stun:stun1.l.google.com:19302"] }
    ])
}

async fn create_task_hint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let intent = body
        .get("intent")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if intent.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "intent is required" })),
        )
            .into_response();
    }
    let task_id = uuid::Uuid::new_v4();
    let now = now_ms();
    let deadline_ms = body
        .get("deadline_ms")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(now.saturating_add(session_state::default_task_deadline_ms().max(1_000)));
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "task_id": task_id,
            "status": "accepted_hint",
            "intent": intent,
            "deadline_ms": deadline_ms,
            "note": "Connect to /v1/realtime and emit task_requested for live orchestration.",
            "server_time_ms": now,
        })),
    )
        .into_response()
}

async fn mcp_tools(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let Some(mcp) = &state.mcp else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "MCP not configured; pass --mcp-url" })),
        )
            .into_response();
    };
    match mcp.list_tools().await {
        Ok(tools) => Json(serde_json::json!({ "tools": tools })).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn mcp_call(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    let Some(mcp) = &state.mcp else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "MCP not configured; pass --mcp-url" })),
        )
            .into_response();
    };
    let name = body
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    }
    let arguments = body
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    match mcp.call_tool(name, arguments).await {
        Ok(result) => Json(serde_json::json!(result)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn providers_catalog() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "active_selection": "set via --provider at process start",
        "providers": provider_catalog(),
    }))
}

async fn providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let manifest = state.provider.manifest();
    Json(serde_json::json!({
        "id": manifest.id,
        "adapter_version": manifest.adapter_version,
        "provider_class": manifest.provider_class,
        "license_class": manifest.license_class,
        "modalities": manifest.modalities,
        "duplex": manifest.duplex,
        "audio": manifest.audio,
        "control": manifest.control,
        "limits": manifest.limits,
        "openlive_version": env!("CARGO_PKG_VERSION"),
        "features": feature_flags(&state),
        "recommended_voices": VOICE_PRESETS.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(),
        "llm": {
            "provider_id": state.llm.settings().provider_id,
            "model": state.llm.settings().model,
            "can_chat": state.llm.settings().can_chat(),
        },
        "docs": {
            "open_source_stack": "docs/open-source-stack.md",
            "credits": "THIRD_PARTY_NOTICES.md"
        }
    }))
}

async fn realtime(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let provider = state.provider.clone();
    let registry = state.registry.clone();
    let store = state.store.clone();
    let safety_enabled = state.safety_enabled;
    ws.max_message_size(256 * 1_024)
        .max_frame_size(256 * 1_024)
        .on_upgrade(move |socket| {
            session::run(
                socket,
                provider,
                registry,
                session::SessionOptions {
                    store,
                    safety_enabled,
                },
            )
        })
}

async fn realtime_session(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(response) = require_api_key(&state, &headers) {
        return response;
    }
    match state.provider.create_client_secret().await {
        Ok(Some(secret)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "client_secret": { "value": secret } })),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "provider does not support client secrets" })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

#[allow(clippy::result_large_err)]
fn require_api_key(state: &AppState, headers: &HeaderMap) -> Result<(), axum::response::Response> {
    let Some(expected) = state.api_key.as_deref() else {
        return Ok(());
    };
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| headers.get("x-openlive-key").and_then(|v| v.to_str().ok()));
    if provided == Some(expected) {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid or missing API key" })),
        )
            .into_response())
    }
}

fn feature_flags(state: &AppState) -> serde_json::Value {
    serde_json::json!({
        "webrtc_session": true,
        "webrtc_ice": true,
        "webrtc_offer_scaffold": true,
        "gateway_webrtc": state.webrtc.is_some(),
        "deep_cognition": true,
        "knowledge_retrieval": true,
        "hybrid_streaming": true,
        "provider_catalog": true,
        "transcript_export": true,
        "background_agent": true,
        "internal_agent_tools": true,
        "multi_agent_pool": true,
        "agent_classes": true,
        "pool_sse": true,
        "pool_start_async": true,
        "session_context": true,
        "user_profile": true,
        "voice_confirm": true,
        "max_agents": 50,
        "sandbox_workspace": true,
        "sandbox_browse_url": true,
        "sandbox_headless_browser": true,
        "sandbox_screenshot": true,
        "sandbox_pdf": true,
        "sandbox_media_gallery": true,
        "agent_citations": true,
        "durable_memory": true,
        "deep_search": true,
        "llm_providers": true,
        "voice_preview": true,
        "semantic_endpointing": true,
        "client_rnnoise": true,
        "client_silero_vad": true,
        "nlms_aec": true,
        "emotion_vad": true,
        "plc_jitter": true,
        "open_voice_piper": true,
        "task_orchestration": true,
        "visual_cards": true,
        "live_translation_card": true,
        "moshi_provider": true,
        "developer_api": true,
        "session_persistence": state.store.is_some(),
        "streaming_safety": state.safety_enabled,
        "mcp_client": state.mcp.is_some(),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
