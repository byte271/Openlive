use std::{net::SocketAddr, path::PathBuf, sync::Arc};

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
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use openlive_protocol::{
    ErrorEvent, EventEnvelope, InteractionAction, Observation, OutputAudioCancel, ProviderClass,
    RealtimeEvent, SessionConfigured, SessionCreated,
};
use openlive_provider::{MockDuplexProvider, ProviderEmission, RealtimeProvider, ResponseRequest};
use openlive_runtime::{ChronosConfig, SessionEngine};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "openlive-gateway")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
    #[arg(long, default_value = "apps/openlive-gateway/web")]
    web_dir: PathBuf,
}

#[derive(Clone)]
struct AppState {
    provider: Arc<MockDuplexProvider>,
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
    let state = AppState {
        provider: Arc::new(MockDuplexProvider::default()),
    };
    let static_files = ServeDir::new(&args.web_dir).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/providers", get(providers))
        .route("/v1/realtime", get(realtime))
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    info!(address = %args.listen, web_dir = %args.web_dir.display(), "Openlive gateway listening");
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
    ws.on_upgrade(move |socket| run_session(socket, state.provider))
}

enum SessionCommand {
    ProviderEmission {
        generation_id: Uuid,
        base_media_time_us: u64,
        emission: ProviderEmission,
    },
    ProviderComplete {
        generation_id: Uuid,
    },
}

struct ActiveGeneration {
    id: Uuid,
    cancellation: CancellationToken,
}

#[allow(clippy::too_many_lines)]
async fn run_session(socket: WebSocket, provider: Arc<MockDuplexProvider>) {
    let session_id = Uuid::new_v4();
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

    let profile = openlive_protocol::InteractionProfile::default();
    let mut engine = SessionEngine::new(session_id, ChronosConfig::default(), profile);
    let mut sequence = 0_u64;
    let mut active_generation: Option<ActiveGeneration> = None;
    let mut turn_tracker = TurnTracker::default();

    let manifest = provider.manifest();
    send_event(
        &outgoing_sender,
        EventEnvelope::new(
            session_id,
            "session",
            next_sequence(&mut sequence),
            0,
            RealtimeEvent::SessionCreated(SessionCreated {
                model: manifest.id,
                provider_class: ProviderClass::Mock,
                input_sample_rate: 16_000,
                output_sample_rate: 24_000,
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
                        let parsed = serde_json::from_str::<EventEnvelope>(&text);
                        let event = match parsed {
                            Ok(event) => event,
                            Err(error) => {
                                send_protocol_error(
                                    &outgoing_sender,
                                    session_id,
                                    &mut sequence,
                                    0,
                                    "invalid_json",
                                    error.to_string(),
                                ).await;
                                continue;
                            }
                        };
                        if event.session_id != session_id {
                            send_protocol_error(
                                &outgoing_sender,
                                session_id,
                                &mut sequence,
                                event.media_time_us,
                                "session_mismatch",
                                "event session_id does not match this connection".to_owned(),
                            ).await;
                            continue;
                        }

                        match event.event {
                            RealtimeEvent::InputAudioFrame(frame) => {
                                let speech_probability = speech_probability(&frame.audio_b64);
                                let completion = turn_tracker.observe(
                                    event.media_time_us,
                                    speech_probability,
                                );
                                let observation = EventEnvelope::new(
                                    session_id,
                                    "observations",
                                    next_sequence(&mut sequence),
                                    event.media_time_us,
                                    RealtimeEvent::Observation(Observation {
                                        speech_probability,
                                        echo_probability: 0.0,
                                        target_speaker_probability: 1.0,
                                        semantic_completeness: completion,
                                        prosodic_finality: completion,
                                    }),
                                ).with_parent(event.event_id);
                                send_event(&outgoing_sender, observation.clone()).await;

                                match engine.process(&observation) {
                                    Ok(decisions) => {
                                        for decision_event in decisions {
                                            let action = match &decision_event.event {
                                                RealtimeEvent::InteractionDecision(decision) => {
                                                    Some(decision.action)
                                                }
                                                _ => None,
                                            };
                                            send_event(&outgoing_sender, decision_event).await;
                                            if let Some(action) = action {
                                                handle_action(
                                                    action,
                                                    event.media_time_us,
                                                    session_id,
                                                    &provider,
                                                    &outgoing_sender,
                                                    &command_sender,
                                                    &mut sequence,
                                                    &mut engine,
                                                    &mut active_generation,
                                                ).await;
                                            }
                                        }
                                    }
                                    Err(error) => {
                                        send_protocol_error(
                                            &outgoing_sender,
                                            session_id,
                                            &mut sequence,
                                            event.media_time_us,
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
                            RealtimeEvent::Ping => {
                                send_event(
                                    &outgoing_sender,
                                    EventEnvelope::new(
                                        session_id,
                                        "session",
                                        next_sequence(&mut sequence),
                                        event.media_time_us,
                                        RealtimeEvent::Pong,
                                    ).with_parent(event.event_id),
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
                let Some(command) = command else {
                    break;
                };
                match command {
                    SessionCommand::ProviderEmission {
                        generation_id,
                        base_media_time_us,
                        emission,
                    } => {
                        let envelope = EventEnvelope::new(
                            session_id,
                            provider_stream_id(&emission.event),
                            next_sequence(&mut sequence),
                            base_media_time_us.saturating_add(emission.media_offset_us),
                            emission.event,
                        ).with_generation(generation_id);
                        send_event(&outgoing_sender, envelope).await;
                    }
                    SessionCommand::ProviderComplete { generation_id } => {
                        engine.mark_response_complete(generation_id);
                        if active_generation.as_ref().is_some_and(|active| active.id == generation_id) {
                            active_generation = None;
                        }
                    }
                }
            }
        }
    }

    if let Some(active) = active_generation {
        active.cancellation.cancel();
    }
    drop(outgoing_sender);
    let _ = writer.await;
    info!(%session_id, "realtime session closed");
}

#[allow(clippy::too_many_arguments)]
async fn handle_action(
    action: InteractionAction,
    media_time_us: u64,
    session_id: Uuid,
    provider: &Arc<MockDuplexProvider>,
    outgoing_sender: &mpsc::Sender<EventEnvelope>,
    command_sender: &mpsc::Sender<SessionCommand>,
    sequence: &mut u64,
    engine: &mut SessionEngine,
    active_generation: &mut Option<ActiveGeneration>,
) {
    match action {
        InteractionAction::StartResponse => {
            if active_generation.is_some() {
                return;
            }
            let generation_id = Uuid::new_v4();
            let cancellation = CancellationToken::new();
            let request = ResponseRequest {
                session_id,
                generation_id,
                prompt: "A speech turn completed in the local alpha.".to_owned(),
                cancellation: cancellation.clone(),
            };
            match provider.start_response(request).await {
                Ok(mut stream) => {
                    engine.mark_response_started(generation_id);
                    *active_generation = Some(ActiveGeneration {
                        id: generation_id,
                        cancellation,
                    });
                    let command_sender = command_sender.clone();
                    tokio::spawn(async move {
                        while let Some(emission) = stream.recv().await {
                            if command_sender
                                .send(SessionCommand::ProviderEmission {
                                    generation_id,
                                    base_media_time_us: media_time_us,
                                    emission,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = command_sender
                            .send(SessionCommand::ProviderComplete { generation_id })
                            .await;
                    });
                }
                Err(error) => {
                    send_protocol_error(
                        outgoing_sender,
                        session_id,
                        sequence,
                        media_time_us,
                        "provider_error",
                        error.to_string(),
                    )
                    .await;
                }
            }
        }
        InteractionAction::HardYield => {
            if let Some(active) = active_generation.take() {
                active.cancellation.cancel();
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
        InteractionAction::Replan => {
            if let Some(active) = active_generation.take() {
                active.cancellation.cancel();
            }
        }
        _ => {}
    }
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

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn speech_probability(audio_b64: &str) -> f32 {
    let Ok(bytes) = BASE64.decode(audio_b64) else {
        return 0.0;
    };
    if bytes.len() < 2 {
        return 0.0;
    }
    let mut sum_squares = 0.0_f64;
    let mut samples = 0_u64;
    for pair in bytes.chunks_exact(2) {
        let sample = f64::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0;
        sum_squares += sample * sample;
        samples += 1;
    }
    if samples == 0 {
        return 0.0;
    }
    let rms = (sum_squares / samples as f64).sqrt() as f32;
    ((rms - 0.008) / 0.055).clamp(0.0, 1.0)
}

fn provider_stream_id(event: &RealtimeEvent) -> &'static str {
    match event {
        RealtimeEvent::OutputAudioFrame(_) | RealtimeEvent::OutputAudioCancel(_) => {
            "assistant_audio"
        }
        RealtimeEvent::OutputTextDelta(_) | RealtimeEvent::OutputTextFinal(_) => "assistant_text",
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
    fn silence_has_low_probability() {
        let audio = BASE64.encode(vec![0_u8; 640]);
        assert!(speech_probability(&audio).abs() < f32::EPSILON);
    }

    #[test]
    fn loud_pcm_has_high_probability() {
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
        assert!(speech_probability(&BASE64.encode(bytes)) > 0.9);
    }
}
