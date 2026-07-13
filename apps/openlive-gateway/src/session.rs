use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::StreamExt;
use openlive_audio::{AcousticFrontend, EndpointingTracker};
use openlive_protocol::{
    ErrorEvent, EventEnvelope, InteractionAction, LatencyMark, LatencyPhase, Observation,
    OutputAudioCancel, OutputAudioPlayed, ProviderLifecycleState, ProviderManifest, RealtimeEvent,
    SessionConfigured, SessionCreated, PROTOCOL_VERSION,
};
use openlive_provider::{
    ProviderEmission, ProviderInput, ProviderSessionRequest, RealtimeProvider,
};
use openlive_runtime::{AnswerLeaseManager, ChronosConfig, SessionEngine};
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::session_state::{ActiveGeneration, LatencyTracker, PlayoutTracker, RepairContext};
use crate::transport::WebSocketTransport;

enum SessionCommand {
    ProviderEmission(ProviderEmission),
}

struct SessionCoordinator {
    session_id: Uuid,
    outgoing: mpsc::Sender<EventEnvelope>,
    provider_input: mpsc::Sender<ProviderInput>,
    sequence: u64,
    engine: SessionEngine,
    leases: AnswerLeaseManager,
    active_generation: Option<ActiveGeneration>,
    endpointing: EndpointingTracker,
    acoustics: AcousticFrontend,
    playout: PlayoutTracker,
    repair: RepairContext,
}

impl SessionCoordinator {
    fn new(
        session_id: Uuid,
        outgoing: mpsc::Sender<EventEnvelope>,
        provider_input: mpsc::Sender<ProviderInput>,
    ) -> Self {
        let profile = openlive_protocol::InteractionProfile::default();
        Self {
            session_id,
            outgoing,
            provider_input,
            sequence: 0,
            engine: SessionEngine::new(session_id, ChronosConfig::default(), profile),
            leases: AnswerLeaseManager::new(session_id),
            active_generation: None,
            endpointing: EndpointingTracker::default(),
            acoustics: AcousticFrontend::default(),
            playout: PlayoutTracker::default(),
            repair: RepairContext::default(),
        }
    }

    async fn announce(&mut self, manifest: ProviderManifest) {
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
        let event = self.envelope(
            "session",
            0,
            RealtimeEvent::SessionCreated(SessionCreated {
                model: manifest.id,
                provider_class: manifest.provider_class,
                input_sample_rate,
                output_sample_rate,
            }),
        );
        self.send(event).await;
    }

    async fn handle_text(&mut self, text: &str) {
        let Some(event) = self.parse_client_event(text).await else {
            return;
        };
        self.handle_client_event(event).await;
    }

    async fn handle_client_event(&mut self, event: EventEnvelope) {
        let media_time_us = event.media_time_us;
        let parent_event_id = event.event_id;
        match event.event {
            RealtimeEvent::InputAudioFrame(frame) => {
                self.handle_audio_frame(frame, media_time_us, parent_event_id)
                    .await;
            }
            RealtimeEvent::SessionConfigured(SessionConfigured {
                interaction_profile,
            }) => {
                self.engine.update_profile(interaction_profile);
            }
            RealtimeEvent::OutputAudioPlayed(OutputAudioPlayed { last_media_time_us }) => {
                self.playout.played(last_media_time_us);
            }
            RealtimeEvent::Ping => {
                let event = self
                    .envelope("session", media_time_us, RealtimeEvent::Pong)
                    .with_parent(parent_event_id);
                self.send(event).await;
            }
            _ => {}
        }
    }

    async fn handle_audio_frame(
        &mut self,
        frame: openlive_protocol::InputAudioFrame,
        media_time_us: u64,
        parent_event_id: Uuid,
    ) {
        let _ = self
            .provider_input
            .send(ProviderInput::AudioFrame {
                media_time_us,
                frame: frame.clone(),
            })
            .await;
        let analysis = match self.acoustics.analyze(&frame, self.playout.is_active()) {
            Ok(analysis) => analysis,
            Err(message) => {
                self.send_error(media_time_us, "invalid_audio_frame", message)
                    .await;
                return;
            }
        };
        let endpointing =
            self.endpointing
                .observe(media_time_us, frame.frame_duration_ms, &analysis);
        let prediction = self
            .envelope(
                "endpointing",
                media_time_us,
                RealtimeEvent::EndpointingPrediction(endpointing.clone()),
            )
            .with_parent(parent_event_id);
        self.send(prediction).await;

        let observation = self
            .envelope(
                "observations",
                media_time_us,
                RealtimeEvent::Observation(Observation {
                    speech_probability: analysis.speech_probability,
                    echo_probability: analysis.echo_probability,
                    target_speaker_probability: analysis.target_speaker_probability,
                    turn_completion_confidence: endpointing.turn_completion_confidence,
                    prosodic_finality: endpointing.prosodic_finality,
                }),
            )
            .with_parent(parent_event_id);
        self.send(observation.clone()).await;
        self.apply_observation(observation, media_time_us).await;
    }

    async fn apply_observation(&mut self, observation: EventEnvelope, media_time_us: u64) {
        match self.engine.process(&observation) {
            Ok(decisions) => {
                for mut decision in decisions {
                    let action = decision_action(&decision);
                    if matches!(action, Some(InteractionAction::HardYield)) {
                        if let Some(active) = self.active_generation.as_ref() {
                            decision = decision.with_generation(active.id);
                        }
                    }
                    self.send(decision).await;
                    if let Some(action) = action {
                        self.handle_action(action, media_time_us).await;
                    }
                }
            }
            Err(error) => {
                self.send_error(media_time_us, "runtime_error", error.to_string())
                    .await;
            }
        }
    }

    async fn handle_action(&mut self, action: InteractionAction, media_time_us: u64) {
        match action {
            InteractionAction::Listen => {
                self.leases.begin_user_turn();
            }
            InteractionAction::StartResponse => {
                self.start_response(media_time_us).await;
            }
            InteractionAction::HardYield | InteractionAction::Replan => {
                self.cancel_response(action, media_time_us).await;
            }
            _ => {}
        }
    }

    async fn start_response(&mut self, media_time_us: u64) {
        if self.active_generation.is_some() {
            return;
        }
        let generation_id = Uuid::new_v4();
        let prompt_hint = self.repair.take_prompt();
        self.leases.issue(generation_id);
        let conversation_version = self
            .leases
            .active()
            .map(|lease| lease.conversation_version)
            .unwrap_or_default();
        self.engine.mark_response_started(generation_id);
        self.active_generation = Some(ActiveGeneration {
            id: generation_id,
            base_media_time_us: media_time_us,
            latency: LatencyTracker::new(),
        });
        self.send_latency(
            media_time_us,
            generation_id,
            LatencyMark {
                phase: LatencyPhase::ResponseCommitted,
                elapsed_us: 0,
            },
        )
        .await;
        if self
            .provider_input
            .send(ProviderInput::CommitResponse {
                generation_id,
                conversation_version,
                media_time_us,
                prompt_hint,
            })
            .await
            .is_err()
        {
            self.send_error(
                media_time_us,
                "provider_closed",
                "provider input channel closed".to_owned(),
            )
            .await;
        }
    }

    async fn cancel_response(&mut self, action: InteractionAction, media_time_us: u64) {
        let Some(active) = self.active_generation.take() else {
            return;
        };
        if matches!(action, InteractionAction::HardYield) {
            self.repair.record_interruption(active.id, media_time_us);
        }
        self.send_latency(
            media_time_us,
            active.id,
            active.latency.mark(LatencyPhase::CancelRequested),
        )
        .await;
        self.playout.cancel();
        self.leases.revoke(active.id);
        let _ = self
            .provider_input
            .send(ProviderInput::CancelGeneration {
                generation_id: active.id,
            })
            .await;
        if matches!(action, InteractionAction::HardYield) {
            let event = self
                .envelope(
                    "assistant_audio",
                    media_time_us,
                    RealtimeEvent::OutputAudioCancel(OutputAudioCancel {
                        requested_cutoff_us: media_time_us,
                        reason: "confirmed user barge-in".to_owned(),
                        fade_ms: 35,
                    }),
                )
                .with_generation(active.id);
            self.send(event).await;
        }
    }

    async fn handle_provider_emission(&mut self, emission: ProviderEmission) {
        let Some(generation_id) = emission.generation_id else {
            let event = self.envelope(
                provider_stream_id(&emission.event),
                emission.media_offset_us,
                emission.event,
            );
            self.send(event).await;
            return;
        };
        if !self.leases.accepts(generation_id) {
            return;
        }
        let Some(active) = self
            .active_generation
            .as_mut()
            .filter(|active| active.id == generation_id)
        else {
            return;
        };
        let latency_marks = active.latency.observe(&emission.event);
        let media_time_us = active
            .base_media_time_us
            .saturating_add(emission.media_offset_us);
        for mark in latency_marks {
            self.send_latency(media_time_us, generation_id, mark).await;
        }
        if matches!(emission.event, RealtimeEvent::OutputAudioFrame(_)) {
            self.playout.sent(media_time_us);
        }
        let is_complete = matches!(
            &emission.event,
            RealtimeEvent::ProviderState(state)
                if state.state == ProviderLifecycleState::Complete
        );
        let event = self
            .envelope(
                provider_stream_id(&emission.event),
                media_time_us,
                emission.event,
            )
            .with_generation(generation_id);
        self.send(event).await;
        if is_complete {
            self.engine.mark_response_complete(generation_id);
            self.active_generation = None;
        }
    }

    async fn close(&mut self) {
        if let Some(active) = self.active_generation.take() {
            let _ = self
                .provider_input
                .send(ProviderInput::CancelGeneration {
                    generation_id: active.id,
                })
                .await;
        }
        let _ = self.provider_input.send(ProviderInput::Close).await;
    }

    async fn parse_client_event(&mut self, text: &str) -> Option<EventEnvelope> {
        let event = match serde_json::from_str::<EventEnvelope>(text) {
            Ok(event) => event,
            Err(error) => {
                self.send_error(0, "invalid_event", error.to_string()).await;
                return None;
            }
        };
        if event.session_id != self.session_id {
            self.send_error(
                event.media_time_us,
                "session_mismatch",
                "event session_id does not match this connection".to_owned(),
            )
            .await;
            return None;
        }
        if event.protocol_version != PROTOCOL_VERSION {
            self.send_error(
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

    async fn send_error(&mut self, media_time_us: u64, code: &str, message: String) {
        let event = self.envelope(
            "errors",
            media_time_us,
            RealtimeEvent::Error(ErrorEvent {
                code: code.to_owned(),
                message,
                recoverable: true,
            }),
        );
        self.send(event).await;
    }

    async fn send_latency(&mut self, media_time_us: u64, generation_id: Uuid, mark: LatencyMark) {
        let event = self
            .envelope("telemetry", media_time_us, RealtimeEvent::LatencyMark(mark))
            .with_generation(generation_id);
        self.send(event).await;
    }

    fn envelope(
        &mut self,
        stream_id: &str,
        media_time_us: u64,
        event: RealtimeEvent,
    ) -> EventEnvelope {
        EventEnvelope::new(
            self.session_id,
            stream_id,
            next_sequence(&mut self.sequence),
            media_time_us,
            event,
        )
    }

    async fn send(&self, event: EventEnvelope) {
        if self.outgoing.send(event).await.is_err() {
            warn!("session writer closed");
        }
    }
}

pub(crate) async fn run(socket: WebSocket, provider: Arc<dyn RealtimeProvider>) {
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
    let mut transport = WebSocketTransport::start(socket);
    let outgoing_sender = transport.outgoing.clone();
    let (command_sender, mut command_receiver) = mpsc::channel::<SessionCommand>(128);

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

    let mut coordinator =
        SessionCoordinator::new(session_id, outgoing_sender.clone(), provider_input);
    coordinator.announce(provider.manifest()).await;
    loop {
        tokio::select! {
            incoming = transport.incoming.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                match incoming {
                    Ok(Message::Text(text)) => coordinator.handle_text(&text).await,
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_)) => {}
                }
            }
            command = command_receiver.recv() => {
                let Some(SessionCommand::ProviderEmission(emission)) = command else {
                    break;
                };
                coordinator.handle_provider_emission(emission).await;
            }
        }
    }

    coordinator.close().await;
    provider_forwarder.abort();
    drop(coordinator);
    drop(outgoing_sender);
    transport.finish().await;
    info!(%session_id, "realtime session closed");
}

fn decision_action(event: &EventEnvelope) -> Option<InteractionAction> {
    match &event.event {
        RealtimeEvent::InteractionDecision(decision) => Some(decision.action),
        _ => None,
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
        RealtimeEvent::EndpointingPrediction(_) => "endpointing",
        _ => "provider",
    }
}

fn next_sequence(sequence: &mut u64) -> u64 {
    *sequence = sequence.saturating_add(1);
    *sequence
}
