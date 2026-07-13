use std::{env, net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use clap::{Parser, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use openlive_protocol::{
    ErrorEvent, EventEnvelope, InputAudioFrame, InteractionAction, LatencyMark, LatencyPhase,
    Observation, OutputAudioCancel, OutputAudioPlayed, RealtimeEvent, SessionConfigured,
    SessionCreated, TaskCreated, TaskResult, PROTOCOL_VERSION,
};
use openlive_provider::{
    MockDuplexProvider, OpenAiCompatibleConfig, OpenAiCompatibleProvider, OpenAiRealtimeConfig,
    OpenAiRealtimeProvider, ProviderEmission, ProviderInput, ProviderSessionRequest,
    RealtimeProvider,
};
use openlive_runtime::{AnswerLeaseManager, ChronosConfig, SessionEngine};
use tokio::sync::mpsc;
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ProviderKind {
    Mock,
    OpenaiCompatible,
    OpenaiRealtime,
}

#[derive(Debug, Parser)]
#[command(name = "openlive-gateway")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
    #[arg(long, default_value = "apps/openlive-gateway/web")]
    web_dir: PathBuf,
    #[arg(long, value_enum, default_value_t = ProviderKind::Mock)]
    provider: ProviderKind,
    #[arg(long, default_value = "http://127.0.0.1:8000/v1")]
    model_base_url: String,
    #[arg(long, default_value = "whisper-1")]
    asr_model: String,
    #[arg(long, default_value = "default")]
    llm_model: String,
    #[arg(long, default_value = "tts-1")]
    tts_model: String,
    #[arg(long, default_value = "alloy")]
    voice: String,
    #[arg(long, default_value = "wss://api.openai.com/v1/realtime")]
    realtime_url: String,
    #[arg(long, default_value = "gpt-4o-realtime-preview")]
    realtime_model: String,
    #[arg(long, default_value = "OPENLIVE_MODEL_API_KEY")]
    api_key_env: String,
}

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
    let provider = build_provider(&args)?;
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

fn build_provider(args: &Args) -> Result<Arc<dyn RealtimeProvider>, Box<dyn std::error::Error>> {
    match args.provider {
        ProviderKind::Mock => Ok(Arc::new(MockDuplexProvider::default())),
        ProviderKind::OpenaiCompatible => {
            let provider = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
                base_url: args.model_base_url.clone(),
                api_key: env::var(&args.api_key_env).ok(),
                asr_model: args.asr_model.clone(),
                llm_model: args.llm_model.clone(),
                tts_model: args.tts_model.clone(),
                voice: args.voice.clone(),
                system_prompt: "Respond naturally and concisely for spoken conversation."
                    .to_owned(),
            })?;
            Ok(Arc::new(provider))
        }
        ProviderKind::OpenaiRealtime => {
            let provider = OpenAiRealtimeProvider::new(OpenAiRealtimeConfig {
                url: args.realtime_url.clone(),
                api_key: env::var(&args.api_key_env).ok(),
                model: args.realtime_model.clone(),
                voice: args.voice.clone(),
                instructions: "Respond naturally and concisely for spoken conversation.".to_owned(),
            })?;
            Ok(Arc::new(provider))
        }
    }
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
        .on_upgrade(move |socket| run_session(socket, state.provider))
}

enum SessionCommand {
    ProviderEmission(ProviderEmission),
}

#[derive(Debug)]
struct ActiveGeneration {
    id: Uuid,
    base_media_time_us: u64,
    latency: LatencyTracker,
}

#[derive(Debug)]
struct LatencyTracker {
    started_at: Instant,
    first_provider_event: bool,
    first_text_delta: bool,
    first_audio_frame: bool,
}

impl LatencyTracker {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            first_provider_event: false,
            first_text_delta: false,
            first_audio_frame: false,
        }
    }

    fn observe(&mut self, event: &RealtimeEvent) -> Vec<LatencyMark> {
        let mut marks = Vec::new();
        if !self.first_provider_event {
            self.first_provider_event = true;
            marks.push(self.mark(LatencyPhase::FirstProviderEvent));
        }
        if matches!(event, RealtimeEvent::OutputTextDelta(_)) && !self.first_text_delta {
            self.first_text_delta = true;
            marks.push(self.mark(LatencyPhase::FirstTextDelta));
        }
        if matches!(event, RealtimeEvent::OutputAudioFrame(_)) && !self.first_audio_frame {
            self.first_audio_frame = true;
            marks.push(self.mark(LatencyPhase::FirstAudioFrame));
        }
        if matches!(
            event,
            RealtimeEvent::ProviderState(state) if state.state == "complete"
        ) {
            marks.push(self.mark(LatencyPhase::ProviderComplete));
        }
        marks
    }

    fn mark(&self, phase: LatencyPhase) -> LatencyMark {
        LatencyMark {
            phase,
            elapsed_us: u64::try_from(self.started_at.elapsed().as_micros()).unwrap_or(u64::MAX),
        }
    }
}

#[derive(Default)]
struct PlayoutTracker {
    last_sent_media_time_us: u64,
    last_played_media_time_us: u64,
}

impl PlayoutTracker {
    fn sent(&mut self, media_time_us: u64) {
        self.last_sent_media_time_us = self.last_sent_media_time_us.max(media_time_us);
    }

    fn played(&mut self, media_time_us: u64) {
        self.last_played_media_time_us = self.last_played_media_time_us.max(media_time_us);
    }

    const fn is_active(&self) -> bool {
        self.last_sent_media_time_us > self.last_played_media_time_us
    }

    fn cancel(&mut self) {
        self.last_played_media_time_us = self.last_sent_media_time_us;
    }
}

#[allow(clippy::too_many_lines)]
async fn run_session(socket: WebSocket, provider: Arc<dyn RealtimeProvider>) {
    let session_id = Uuid::new_v4();
    let provider_session = match provider
        .open_session(ProviderSessionRequest { session_id })
        .await
    {
        Ok(session) => session,
        Err(error) => {
            warn!(%session_id, %error, "provider session failed");
            return;
        }
    };
    let (provider_input, mut provider_output) = provider_session.into_parts();
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (outgoing_sender, mut outgoing_receiver) = mpsc::channel::<EventEnvelope>(128);
    let (command_sender, mut command_receiver) = mpsc::channel::<SessionCommand>(128);

    let writer = tokio::spawn(async move {
        while let Some(event) = outgoing_receiver.recv().await {
            let Ok(json) = serde_json::to_string(&event) else {
                continue;
            };
            if socket_sender.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });
    let provider_forwarder = tokio::spawn(async move {
        while let Some(emission) = provider_output.recv().await {
            if command_sender
                .send(SessionCommand::ProviderEmission(emission))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let profile = openlive_protocol::InteractionProfile::default();
    let mut engine = SessionEngine::new(session_id, ChronosConfig::default(), profile);
    let mut leases = AnswerLeaseManager::new(session_id);
    let mut sequence = 0_u64;
    let mut active_generation: Option<ActiveGeneration> = None;
    let mut turn_tracker = TurnTracker::default();
    let mut acoustic_frontend = AcousticFrontend::default();
    let mut playout = PlayoutTracker::default();

    let manifest = provider.manifest();
    let input_sample_rate = manifest
        .audio
        .input_sample_rates
        .first()
        .copied()
        .unwrap_or(16_000);
    let output_sample_rate = manifest
        .audio
        .output_sample_rates
        .first()
        .copied()
        .unwrap_or(24_000);
    send_event(
        &outgoing_sender,
        EventEnvelope::new(
            session_id,
            "session",
            next_sequence(&mut sequence),
            0,
            RealtimeEvent::SessionCreated(SessionCreated {
                model: manifest.id,
                provider_class: manifest.provider_class,
                input_sample_rate,
                output_sample_rate,
            }),
        ),
    )
    .await;

    loop {
        tokio::select! {
            incoming = socket_receiver.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                match incoming {
                    Ok(Message::Text(text)) => {
                        let Some(event) = parse_client_event(
                            &text,
                            session_id,
                            &outgoing_sender,
                            &mut sequence,
                        ).await else {
                            continue;
                        };
                        let media_time_us = event.media_time_us;
                        let parent_event_id = event.event_id;
                        match event.event {
                            RealtimeEvent::InputAudioFrame(frame) => {
                                let _ = provider_input.send(ProviderInput::AudioFrame {
                                    media_time_us,
                                    frame: frame.clone(),
                                }).await;
                                let features = match acoustic_frontend.analyze(
                                    &frame,
                                    playout.is_active(),
                                ) {
                                    Ok(features) => features,
                                    Err(message) => {
                                        send_protocol_error(
                                            &outgoing_sender,
                                            session_id,
                                            &mut sequence,
                                            media_time_us,
                                            "invalid_audio_frame",
                                            message,
                                        ).await;
                                        continue;
                                    }
                                };
                                let completion = turn_tracker.observe(
                                    media_time_us,
                                    features.speech_probability,
                                );
                                let observation = EventEnvelope::new(
                                    session_id,
                                    "observations",
                                    next_sequence(&mut sequence),
                                    media_time_us,
                                    RealtimeEvent::Observation(Observation {
                                        speech_probability: features.speech_probability,
                                        echo_probability: features.echo_probability,
                                        target_speaker_probability: 1.0,
                                        semantic_completeness: completion,
                                        prosodic_finality: completion,
                                    }),
                                ).with_parent(parent_event_id);
                                send_event(&outgoing_sender, observation.clone()).await;

                                match engine.process(&observation) {
                                    Ok(decisions) => {
                                        for mut decision_event in decisions {
                                            let action = decision_action(&decision_event);
                                            if matches!(action, Some(InteractionAction::HardYield)) {
                                                if let Some(active) = active_generation.as_ref() {
                                                    decision_event =
                                                        decision_event.with_generation(active.id);
                                                }
                                            }
                                            send_event(&outgoing_sender, decision_event).await;
                                            if let Some(action) = action {
                                                handle_action(
                                                    action,
                                                    media_time_us,
                                                    session_id,
                                                    &provider_input,
                                                    &outgoing_sender,
                                                    &mut sequence,
                                                    &mut engine,
                                                    &mut leases,
                                                    &mut active_generation,
                                                    &mut playout,
                                                ).await;
                                            }
                                        }
                                    }
                                    Err(error) => {
                                        send_protocol_error(
                                            &outgoing_sender,
                                            session_id,
                                            &mut sequence,
                                            media_time_us,
                                            "runtime_error",
                                            error.to_string(),
                                        ).await;
                                    }
                                }
                            }
                            RealtimeEvent::SessionConfigured(SessionConfigured {
                                interaction_profile,
                            }) => {
                                engine.update_profile(interaction_profile);
                            }
                            RealtimeEvent::OutputAudioPlayed(OutputAudioPlayed {
                                last_media_time_us,
                            }) => {
                                playout.played(last_media_time_us);
                            }
                            RealtimeEvent::Ping => {
                                send_event(
                                    &outgoing_sender,
                                    EventEnvelope::new(
                                        session_id,
                                        "session",
                                        next_sequence(&mut sequence),
                                        media_time_us,
                                        RealtimeEvent::Pong,
                                    ).with_parent(parent_event_id),
                                ).await;
                            }
                            _ => {}
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_)) => {}
                }
            }
            command = command_receiver.recv() => {
                let Some(SessionCommand::ProviderEmission(mut emission)) = command else {
                    break;
                };
                let Some(generation_id) = emission.generation_id else {
                    let envelope = EventEnvelope::new(
                        session_id,
                        provider_stream_id(&emission.event),
                        next_sequence(&mut sequence),
                        emission.media_offset_us,
                        emission.event,
                    );
                    send_event(&outgoing_sender, envelope).await;
                    continue;
                };
                if !leases.accepts(generation_id) {
                    continue;
                }
                let Some(active) = active_generation
                    .as_mut()
                    .filter(|active| active.id == generation_id)
                else {
                    continue;
                };
                stamp_conversation_version(&mut emission.event, &leases);
                let latency_marks = active.latency.observe(&emission.event);
                let media_time_us = active
                    .base_media_time_us
                    .saturating_add(emission.media_offset_us);
                for mark in latency_marks {
                    send_latency_mark(
                        &outgoing_sender,
                        session_id,
                        &mut sequence,
                        media_time_us,
                        generation_id,
                        mark,
                    ).await;
                }
                if matches!(emission.event, RealtimeEvent::OutputAudioFrame(_)) {
                    playout.sent(media_time_us);
                }
                let is_complete = matches!(
                    &emission.event,
                    RealtimeEvent::ProviderState(state) if state.state == "complete"
                );
                let envelope = EventEnvelope::new(
                    session_id,
                    provider_stream_id(&emission.event),
                    next_sequence(&mut sequence),
                    media_time_us,
                    emission.event,
                ).with_generation(generation_id);
                send_event(&outgoing_sender, envelope).await;
                if is_complete {
                    engine.mark_response_complete(generation_id);
                    active_generation = None;
                }
            }
        }
    }

    if let Some(active) = active_generation {
        let _ = provider_input
            .send(ProviderInput::CancelGeneration {
                generation_id: active.id,
            })
            .await;
    }
    let _ = provider_input.send(ProviderInput::Close).await;
    provider_forwarder.abort();
    drop(outgoing_sender);
    let _ = writer.await;
    info!(%session_id, "realtime session closed");
}

#[allow(clippy::too_many_arguments)]
async fn handle_action(
    action: InteractionAction,
    media_time_us: u64,
    session_id: Uuid,
    provider_input: &mpsc::Sender<ProviderInput>,
    outgoing_sender: &mpsc::Sender<EventEnvelope>,
    sequence: &mut u64,
    engine: &mut SessionEngine,
    leases: &mut AnswerLeaseManager,
    active_generation: &mut Option<ActiveGeneration>,
    playout: &mut PlayoutTracker,
) {
    match action {
        InteractionAction::Listen => {
            leases.begin_user_turn();
        }
        InteractionAction::StartResponse => {
            if active_generation.is_some() {
                return;
            }
            let generation_id = Uuid::new_v4();
            leases.issue(generation_id);
            engine.mark_response_started(generation_id);
            *active_generation = Some(ActiveGeneration {
                id: generation_id,
                base_media_time_us: media_time_us,
                latency: LatencyTracker::new(),
            });
            send_latency_mark(
                outgoing_sender,
                session_id,
                sequence,
                media_time_us,
                generation_id,
                LatencyMark {
                    phase: LatencyPhase::ResponseCommitted,
                    elapsed_us: 0,
                },
            )
            .await;
            if provider_input
                .send(ProviderInput::CommitResponse {
                    generation_id,
                    media_time_us,
                    prompt_hint: "Openlive received your turn. Configure a real model endpoint for semantic responses.".to_owned(),
                })
                .await
                .is_err()
            {
                send_protocol_error(
                    outgoing_sender,
                    session_id,
                    sequence,
                    media_time_us,
                    "provider_closed",
                    "provider input channel closed".to_owned(),
                )
                .await;
            }
        }
        InteractionAction::HardYield | InteractionAction::Replan => {
            if let Some(active) = active_generation.take() {
                send_latency_mark(
                    outgoing_sender,
                    session_id,
                    sequence,
                    media_time_us,
                    active.id,
                    active.latency.mark(LatencyPhase::CancelRequested),
                )
                .await;
                playout.cancel();
                leases.revoke(active.id);
                let _ = provider_input
                    .send(ProviderInput::CancelGeneration {
                        generation_id: active.id,
                    })
                    .await;
                if matches!(action, InteractionAction::HardYield) {
                    send_event(
                        outgoing_sender,
                        EventEnvelope::new(
                            session_id,
                            "assistant_audio",
                            next_sequence(sequence),
                            media_time_us,
                            RealtimeEvent::OutputAudioCancel(OutputAudioCancel {
                                requested_cutoff_us: media_time_us,
                                reason: "confirmed user barge-in".to_owned(),
                                fade_ms: 35,
                            }),
                        )
                        .with_generation(active.id),
                    )
                    .await;
                }
            }
        }
        _ => {}
    }
}

fn decision_action(event: &EventEnvelope) -> Option<InteractionAction> {
    match &event.event {
        RealtimeEvent::InteractionDecision(decision) => Some(decision.action),
        _ => None,
    }
}

fn stamp_conversation_version(event: &mut RealtimeEvent, leases: &AnswerLeaseManager) {
    let Some(lease) = leases.active() else {
        return;
    };
    match event {
        RealtimeEvent::TaskCreated(TaskCreated {
            conversation_version,
            ..
        })
        | RealtimeEvent::TaskResult(TaskResult {
            conversation_version,
            ..
        }) => {
            *conversation_version = lease.conversation_version;
        }
        _ => {}
    }
}

async fn parse_client_event(
    text: &str,
    session_id: Uuid,
    outgoing_sender: &mpsc::Sender<EventEnvelope>,
    sequence: &mut u64,
) -> Option<EventEnvelope> {
    let event = match serde_json::from_str::<EventEnvelope>(text) {
        Ok(event) => event,
        Err(error) => {
            send_protocol_error(
                outgoing_sender,
                session_id,
                sequence,
                0,
                "invalid_json",
                error.to_string(),
            )
            .await;
            return None;
        }
    };
    if event.session_id != session_id {
        send_protocol_error(
            outgoing_sender,
            session_id,
            sequence,
            event.media_time_us,
            "session_mismatch",
            "event session_id does not match this connection".to_owned(),
        )
        .await;
        return None;
    }
    if event.protocol_version != PROTOCOL_VERSION {
        send_protocol_error(
            outgoing_sender,
            session_id,
            sequence,
            event.media_time_us,
            "protocol_version_mismatch",
            format!(
                "expected protocol {PROTOCOL_VERSION}, received {}",
                event.protocol_version
            ),
        )
        .await;
        return None;
    }
    Some(event)
}

#[derive(Default)]
struct TurnTracker {
    speech_started_us: Option<u64>,
    silence_started_us: Option<u64>,
}

impl TurnTracker {
    #[allow(clippy::cast_precision_loss)]
    fn observe(&mut self, media_time_us: u64, speech_probability: f32) -> f32 {
        if speech_probability >= 0.62 {
            self.speech_started_us.get_or_insert(media_time_us);
            self.silence_started_us = None;
            return 0.1;
        }
        if self.speech_started_us.is_none() {
            return 0.0;
        }
        let silence_start = *self.silence_started_us.get_or_insert(media_time_us);
        let silence_ms = media_time_us.saturating_sub(silence_start) / 1_000;
        (silence_ms as f32 / 500.0).clamp(0.0, 1.0)
    }
}

#[derive(Debug)]
struct AcousticFeatures {
    speech_probability: f32,
    echo_probability: f32,
}

#[derive(Debug)]
struct AcousticFrontend {
    noise_floor_rms: f32,
}

impl Default for AcousticFrontend {
    fn default() -> Self {
        Self {
            noise_floor_rms: 0.006,
        }
    }
}

impl AcousticFrontend {
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    fn analyze(
        &mut self,
        frame: &InputAudioFrame,
        assistant_playout_active: bool,
    ) -> Result<AcousticFeatures, String> {
        if frame.channels != 1 {
            return Err("only mono input is supported".to_owned());
        }
        if !(8_000..=48_000).contains(&frame.sample_rate) {
            return Err("input sample rate must be between 8 kHz and 48 kHz".to_owned());
        }
        if !(5..=100).contains(&frame.frame_duration_ms) {
            return Err("frame duration must be between 5 ms and 100 ms".to_owned());
        }
        let bytes = BASE64
            .decode(&frame.audio_b64)
            .map_err(|_| "audio_b64 is not valid base64".to_owned())?;
        let expected = usize::try_from(
            u64::from(frame.sample_rate)
                * u64::from(frame.frame_duration_ms)
                * u64::from(frame.channels)
                * 2
                / 1_000,
        )
        .unwrap_or_default();
        if bytes.len() != expected {
            return Err(format!(
                "PCM length mismatch: expected {expected} bytes, received {}",
                bytes.len()
            ));
        }
        let mut sum_squares = 0.0_f64;
        let mut sample_count = 0_u64;
        for pair in bytes.chunks_exact(2) {
            let sample = f64::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0;
            sum_squares += sample * sample;
            sample_count += 1;
        }
        let rms = (sum_squares / sample_count.max(1) as f64).sqrt() as f32;
        let client_probability = frame
            .client_speech_probability
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        if !assistant_playout_active && client_probability < 0.25 {
            self.noise_floor_rms = self.noise_floor_rms.mul_add(0.985, rms * 0.015);
        }
        let ratio = rms / self.noise_floor_rms.max(0.001);
        let server_probability = ((ratio - 1.8) / 5.5).clamp(0.0, 1.0);
        let speech_probability = if frame.client_speech_probability.is_some() {
            server_probability.mul_add(0.45, client_probability * 0.55)
        } else {
            server_probability
        };
        let echo_probability = if assistant_playout_active {
            (server_probability - client_probability).clamp(0.0, 0.35)
        } else {
            0.0
        };
        Ok(AcousticFeatures {
            speech_probability,
            echo_probability,
        })
    }
}

fn provider_stream_id(event: &RealtimeEvent) -> &'static str {
    match event {
        RealtimeEvent::OutputAudioFrame(_) | RealtimeEvent::OutputAudioCancel(_) => {
            "assistant_audio"
        }
        RealtimeEvent::OutputTextDelta(_) | RealtimeEvent::OutputTextFinal(_) => "assistant_text",
        RealtimeEvent::TaskCreated(_) | RealtimeEvent::TaskResult(_) => "cognition",
        RealtimeEvent::LatencyMark(_) => "telemetry",
        _ => "provider",
    }
}

async fn send_protocol_error(
    sender: &mpsc::Sender<EventEnvelope>,
    session_id: Uuid,
    sequence: &mut u64,
    media_time_us: u64,
    code: &str,
    message: String,
) {
    send_event(
        sender,
        EventEnvelope::new(
            session_id,
            "errors",
            next_sequence(sequence),
            media_time_us,
            RealtimeEvent::Error(ErrorEvent {
                code: code.to_owned(),
                message,
                recoverable: true,
            }),
        ),
    )
    .await;
}

async fn send_latency_mark(
    sender: &mpsc::Sender<EventEnvelope>,
    session_id: Uuid,
    sequence: &mut u64,
    media_time_us: u64,
    generation_id: Uuid,
    mark: LatencyMark,
) {
    send_event(
        sender,
        EventEnvelope::new(
            session_id,
            "telemetry",
            next_sequence(sequence),
            media_time_us,
            RealtimeEvent::LatencyMark(mark),
        )
        .with_generation(generation_id),
    )
    .await;
}

async fn send_event(sender: &mpsc::Sender<EventEnvelope>, event: EventEnvelope) {
    if sender.send(event).await.is_err() {
        warn!("session writer closed");
    }
}

fn next_sequence(sequence: &mut u64) -> u64 {
    *sequence = sequence.saturating_add(1);
    *sequence
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_frontend_rejects_wrong_frame_length() {
        let frame = InputAudioFrame {
            audio_b64: BASE64.encode(vec![0_u8; 10]),
            sample_rate: 16_000,
            channels: 1,
            frame_duration_ms: 20,
            client_speech_probability: None,
        };
        let error = AcousticFrontend::default()
            .analyze(&frame, false)
            .expect_err("invalid length");
        assert!(error.contains("PCM length mismatch"));
    }

    #[test]
    fn adaptive_frontend_detects_loud_pcm() {
        let bytes: Vec<u8> = (0..320)
            .flat_map(|index| {
                let sample = if index % 2 == 0 {
                    12_000_i16
                } else {
                    -12_000_i16
                };
                sample.to_le_bytes()
            })
            .collect();
        let frame = InputAudioFrame {
            audio_b64: BASE64.encode(bytes),
            sample_rate: 16_000,
            channels: 1,
            frame_duration_ms: 20,
            client_speech_probability: Some(1.0),
        };
        let features = AcousticFrontend::default()
            .analyze(&frame, false)
            .expect("features");
        assert!(features.speech_probability > 0.9);
    }
}
