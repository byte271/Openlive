use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::StreamExt;
use openlive_audio::{AcousticFrontend, EndpointingTracker};
use openlive_protocol::{
    CapabilityOffer, CapabilitySelected, ErrorEvent, EventEnvelope, EvidenceKind, EvidenceLink,
    EvidenceLinkType, InteractionAction, LatencyMark, LatencyPhase, MediaKind, MediaPacket,
    MediaTransport, Modality, Observation, OutputAudioCancel, OutputAudioPlayed, PcmAudioFrame,
    ProviderLifecycleState, ProviderManifest, RealtimeEvent, SessionConfigured, SessionCreated,
    SessionResume, TaskCancel, TaskOutcome, TaskRequested, VisualInput, VisualInputMode,
    VisualInputRejected, PROTOCOL_REVISION, PROTOCOL_VERSION,
};
use openlive_provider::{
    ProviderEmission, ProviderInput, ProviderOutput, ProviderSessionRequest, RealtimeProvider,
};
use openlive_runtime::{AnswerLeaseManager, ChronosConfig, SessionEngine};
use tokio::sync::mpsc::{self, error::TrySendError};
use tracing::{info, warn};
use uuid::Uuid;

use crate::session_state::{
    ActiveGeneration, ClientTimeline, LatencyTracker, PlayoutTracker, RepairContext, TelemetryGate,
    TaskOrchestrator, PendingOutcome,
};
use crate::transport::{ServerMessage, WebSocketTransport};

enum SessionCommand {
    ProviderEmission(ProviderEmission),
}

struct SessionCoordinator {
    session_id: Uuid,
    outgoing: mpsc::Sender<ServerMessage>,
    provider_input: mpsc::Sender<ProviderInput>,
    provider_manifest: ProviderManifest,
    sequence: u64,
    engine: SessionEngine,
    leases: AnswerLeaseManager,
    active_generation: Option<ActiveGeneration>,
    endpointing: EndpointingTracker,
    acoustics: AcousticFrontend,
    playout: PlayoutTracker,
    repair: RepairContext,
    client_timeline: ClientTimeline,
    dropped_input_frames: u64,
    telemetry_gate: TelemetryGate,
    /// Phase 7: owns task lifecycle, evidence links, and resume buffering.
    task_orchestrator: TaskOrchestrator,
}

impl SessionCoordinator {
    fn new(
        session_id: Uuid,
        outgoing: mpsc::Sender<ServerMessage>,
        provider_input: mpsc::Sender<ProviderInput>,
        provider_manifest: ProviderManifest,
    ) -> Self {
        let profile = openlive_protocol::InteractionProfile::default();
        Self {
            session_id,
            outgoing,
            provider_input,
            provider_manifest,
            sequence: 0,
            engine: SessionEngine::new(session_id, ChronosConfig::default(), profile),
            leases: AnswerLeaseManager::new(session_id),
            active_generation: None,
            endpointing: EndpointingTracker::default(),
            acoustics: AcousticFrontend::default(),
            playout: PlayoutTracker::default(),
            repair: RepairContext::default(),
            client_timeline: ClientTimeline::default(),
            dropped_input_frames: 0,
            telemetry_gate: TelemetryGate::default(),
            task_orchestrator: TaskOrchestrator::new(),
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
                media_transport: MediaTransport::WebsocketBinaryPcm,
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
            RealtimeEvent::SessionConfigured(SessionConfigured {
                interaction_profile,
            }) => {
                self.engine.update_profile(interaction_profile);
            }
            RealtimeEvent::OutputAudioPlayed(OutputAudioPlayed { last_media_time_us }) => {
                self.playout.played(last_media_time_us);
            }
            RealtimeEvent::CapabilityOffer(offer) => {
                self.select_capabilities(media_time_us, parent_event_id, offer)
                    .await;
            }
            RealtimeEvent::VisualInput(visual) => {
                self.handle_visual_input(media_time_us, parent_event_id, visual)
                    .await;
            }
            RealtimeEvent::TaskRequested(request) => {
                self.handle_task_requested(media_time_us, parent_event_id, request)
                    .await;
            }
            RealtimeEvent::TaskCancel(cancel) => {
                self.handle_task_cancel(media_time_us, parent_event_id, cancel)
                    .await;
            }
            RealtimeEvent::SessionResume(resume) => {
                self.handle_session_resume(media_time_us, parent_event_id, resume)
                    .await;
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

    async fn select_capabilities(
        &mut self,
        media_time_us: u64,
        parent_event_id: Uuid,
        offer: CapabilityOffer,
    ) {
        let selected_input = offer
            .requested_modalities
            .input
            .into_iter()
            .filter(|modality| self.provider_manifest.modalities.input.contains(modality))
            .collect::<Vec<_>>();
        let selected_output = offer
            .requested_modalities
            .output
            .into_iter()
            .filter(|modality| self.provider_manifest.modalities.output.contains(modality))
            .collect::<Vec<_>>();
        let provider_has_visual = selected_input
            .iter()
            .any(|modality| matches!(modality, Modality::Image | Modality::Screen));
        let visual_mode = if provider_has_visual {
            VisualInputMode::ExplicitSnapshot
        } else {
            VisualInputMode::Unsupported
        };
        let mut warnings = Vec::new();
        if offer.protocol_revision > PROTOCOL_REVISION {
            warnings.push(format!(
                "client protocol revision {} is newer than gateway revision {}",
                offer.protocol_revision, PROTOCOL_REVISION
            ));
        }
        if offer.visual_input_policy.is_some() && !provider_has_visual {
            warnings.push("the selected provider does not accept visual input".to_owned());
        }
        // Phase 7: resume is now supported by the gateway (buffered outcomes
        // with `event_id` dedup). We mirror the client's request back so the
        // UI knows whether to enable the "Resume" affordance after a drop.
        let resume_supported = offer.supports_resume;
        let selected = CapabilitySelected {
            protocol_revision: PROTOCOL_REVISION,
            provider_manifest: self.provider_manifest.clone(),
            selected_input,
            selected_output,
            visual_mode,
            resume_supported,
            warnings,
        };
        let event = self
            .envelope(
                "capability",
                media_time_us,
                RealtimeEvent::CapabilitySelected(selected),
            )
            .with_parent(parent_event_id);
        self.send(event).await;
    }

    async fn handle_visual_input(
        &mut self,
        media_time_us: u64,
        parent_event_id: Uuid,
        visual: VisualInput,
    ) {
        let (code, message, retryable) =
            if visual.byte_length > 393_216 || visual.width > 1280 || visual.height > 720 {
                (
                    "visual_input_limit_exceeded",
                    "visual input must be at most 1280×720 and 384 KB",
                    true,
                )
            } else if !visual.mime_type.starts_with("image/") {
                (
                    "visual_input_mime_unsupported",
                    "visual input must use an image MIME type",
                    false,
                )
            } else {
                (
                "visual_input_unsupported",
                "the selected provider has no visual-input transport; the frame was not retained",
                false,
            )
            };
        let rejection = RealtimeEvent::VisualInputRejected(VisualInputRejected {
            capture_id: visual.capture_id,
            code: code.to_owned(),
            message: message.to_owned(),
            retryable,
        });
        let event = self
            .envelope("visual", media_time_us, rejection)
            .with_parent(parent_event_id);
        self.send(event).await;
    }

    /// Validate a `TaskRequested`, register it with the orchestrator, and
    /// emit a `TaskAcknowledged` before any provider work begins. The
    /// acknowledgement is buffered for resume replay so a client that
    /// disconnects immediately after sending a task still sees the receipt
    /// when it reconnects.
    ///
    /// If the client supplied `generation_id`, the task is bound to that
    /// generation. Otherwise the task stays unbound and will be bound to
    /// the next generation that starts (see `start_response`).
    async fn handle_task_requested(
        &mut self,
        media_time_us: u64,
        parent_event_id: Uuid,
        request: TaskRequested,
    ) {
        let now_ms = media_time_us / 1_000;
        let provider_id = self.provider_manifest.id.as_str();
        let Some(acknowledgement) = self
            .task_orchestrator
            .admit(request, Some(provider_id), now_ms)
        else
        {
            self.send_error(
                media_time_us,
                "task_rejected",
                "task could not be admitted (empty intent or duplicate id)".to_owned(),
            )
            .await;
            return;
        };
        let event = self
            .envelope(
                "tasks",
                media_time_us,
                RealtimeEvent::TaskAcknowledged(acknowledgement),
            )
            .with_parent(parent_event_id);
        self.send_and_buffer(event).await;
    }

    /// Cancel a task. If the task is active, emit a `TaskOutcome` with
    /// `result = Cancelled`. If the task is already resolved or unknown,
    /// the cancel request is silently ignored (the ledger is append-only).
    async fn handle_task_cancel(
        &mut self,
        media_time_us: u64,
        parent_event_id: Uuid,
        cancel: TaskCancel,
    ) {
        let Some(pending) = self
            .task_orchestrator
            .cancel_task(cancel.task_id, cancel.reason.as_deref())
        else {
            // Unknown or already resolved — not an error, just a no-op.
            return;
        };
        let outcome = TaskOutcome {
            task_id: pending.task_id,
            result: pending.result,
            summary: pending.summary,
            evidence_ids: pending.evidence_ids,
            error_code: pending.error_code,
            error_detail: pending.error_detail,
        };
        let event = self
            .envelope("tasks", media_time_us, RealtimeEvent::TaskOutcome(outcome))
            .with_parent(parent_event_id);
        self.send_and_buffer(event).await;
    }

    /// Replay buffered outcomes whose sequence is strictly greater than
    /// `last_sequence_seen`. The orchestrator deduplicates by `event_id`
    /// so resume never produces duplicate evidence in the client's ledger.
    async fn handle_session_resume(
        &mut self,
        media_time_us: u64,
        parent_event_id: Uuid,
        resume: SessionResume,
    ) {
        if resume.session_id != self.session_id {
            self.send_error(
                media_time_us,
                "session_mismatch",
                "resume session_id does not match this connection".to_owned(),
            )
            .await;
            return;
        }
        let replay = self
            .task_orchestrator
            .replay_after(resume.last_sequence_seen);
        for envelope_json in replay {
            if self
                .outgoing
                .send(ServerMessage::RawText(envelope_json))
                .await
                .is_err()
            {
                warn!("session writer closed during resume replay");
                return;
            }
        }
        let event = self
            .envelope("session", media_time_us, RealtimeEvent::Pong)
            .with_parent(parent_event_id);
        self.send(event).await;
    }

    /// Emit a batch of `PendingOutcome`s produced by the orchestrator
    /// (from `expire_deadlines` or `complete_tasks_for_generation`).
    /// Each outcome is sent on the wire AND buffered for resume replay.
    /// The orchestrator has already removed the task from its active set,
    /// so we just need to serialize and emit.
    async fn emit_pending_outcomes(&mut self, media_time_us: u64, outcomes: Vec<PendingOutcome>) {
        for pending in outcomes {
            let outcome = TaskOutcome {
                task_id: pending.task_id,
                result: pending.result,
                summary: pending.summary,
                evidence_ids: pending.evidence_ids,
                error_code: pending.error_code,
                error_detail: pending.error_detail,
            };
            let event = self
                .envelope("tasks", media_time_us, RealtimeEvent::TaskOutcome(outcome))
                .with_parent(pending.task_id);
            self.send_and_buffer(event).await;
        }
    }

    /// Emit a bidirectional `EvidenceLink` and record it with the
    /// orchestrator. The link is buffered for resume replay so the client's
    /// evidence matrix survives disconnects. Duplicate links are dropped
    /// (the orchestrator deduplicates by `(source, target, link_type)`).
    async fn emit_evidence_link(&mut self, media_time_us: u64, link: EvidenceLink) {
        let inserted = self.task_orchestrator.link_evidence(&link);
        if !inserted {
            return;
        }
        let event = self
            .envelope("evidence", media_time_us, RealtimeEvent::EvidenceLink(link))
            .with_parent(self.session_id);
        self.send_and_buffer(event).await;
    }

    /// Classify a provider event into the appropriate `EvidenceKind`.
    /// This is the real classification logic — no more "everything is
    /// Transcript". The mapping is:
    ///   - `OutputTextDelta` / `OutputTextFinal` → `Transcript`
    ///   - `ProviderState` (Generating/Complete) → `Timing`
    ///   - `LatencyMark` → `Timing`
    ///   - `VisualInputAccepted` → `Visual`
    ///   - Everything else → `None` (not evidence-worthy)
    fn classify_evidence(event: &RealtimeEvent) -> Option<EvidenceKind> {
        match event {
            RealtimeEvent::OutputTextDelta(_) | RealtimeEvent::OutputTextFinal(_) => {
                Some(EvidenceKind::Transcript)
            }
            RealtimeEvent::LatencyMark(_) => Some(EvidenceKind::Timing),
            RealtimeEvent::VisualInputAccepted(_) => Some(EvidenceKind::Visual),
            // ProviderState transitions are timing evidence (they mark
            // generation start/complete). We only classify the interesting
            // transitions, not every state change.
            RealtimeEvent::ProviderState(state)
                if matches!(
                    state.state,
                    ProviderLifecycleState::Generating | ProviderLifecycleState::Complete
                ) =>
            {
                Some(EvidenceKind::Timing)
            }
            _ => None,
        }
    }

    /// Attach a provider event id as evidence to every task bound to
    /// `generation_id`. Tasks bound to other generations (or unbound)
    /// are NOT given this evidence — this is the correctness fix that
    /// prevents evidence from one generation polluting tasks admitted
    /// for a different turn.
    ///
    /// The evidence kind is classified from the event type via
    /// `classify_evidence`. Events that don't match any kind are skipped.
    async fn attach_evidence_to_generation(
        &mut self,
        generation_id: Uuid,
        evidence_id: Uuid,
        event: &RealtimeEvent,
        media_time_us: u64,
    ) {
        let Some(kind) = Self::classify_evidence(event) else {
            return;
        };
        // Only attach to tasks bound to THIS generation. This is the
        // correctness fix — evidence from generation N must not pollute
        // tasks admitted for generation N+1.
        let task_ids = self
            .task_orchestrator
            .task_ids_for_generation(generation_id);
        for task_id in task_ids {
            let attached = self
                .task_orchestrator
                .attach_evidence(task_id, kind, evidence_id);
            if !attached {
                continue;
            }
            self.emit_evidence_link(
                media_time_us,
                EvidenceLink {
                    source_id: task_id,
                    target_id: evidence_id,
                    link_type: EvidenceLinkType::TaskProof,
                    confidence: 1.0,
                },
            )
            .await;
        }
    }

    async fn handle_media(&mut self, packet: MediaPacket) {
        if packet.kind != MediaKind::InputAudio || packet.generation_id.is_some() {
            self.send_error(
                packet.media_time_us,
                "invalid_media_direction",
                "client binary packets must contain input audio".to_owned(),
            )
            .await;
            return;
        }
        if let Err(message) =
            self.client_timeline
                .observe(packet.sequence, "microphone", packet.media_time_us)
        {
            self.send_error(
                packet.media_time_us,
                "invalid_client_timeline",
                message.to_owned(),
            )
            .await;
            return;
        }
        self.handle_audio_frame(packet.audio, packet.media_time_us, Uuid::new_v4())
            .await;
    }

    async fn handle_audio_frame(
        &mut self,
        frame: PcmAudioFrame,
        media_time_us: u64,
        parent_event_id: Uuid,
    ) {
        let analysis = match self.acoustics.analyze(&frame, self.playout.is_active()) {
            Ok(analysis) => analysis,
            Err(message) => {
                self.send_error(media_time_us, "invalid_audio_frame", message)
                    .await;
                return;
            }
        };
        match self.provider_input.try_send(ProviderInput::AudioFrame {
            media_time_us,
            frame: frame.clone(),
        }) {
            Ok(()) => self.dropped_input_frames = 0,
            Err(TrySendError::Full(_)) => {
                self.dropped_input_frames = self.dropped_input_frames.saturating_add(1);
                if self.dropped_input_frames.is_power_of_two() {
                    self.send_error(
                        media_time_us,
                        "provider_backpressure",
                        format!(
                            "dropped {} input frames while the provider was saturated",
                            self.dropped_input_frames
                        ),
                    )
                    .await;
                }
            }
            Err(TrySendError::Closed(_)) => {
                self.send_error(
                    media_time_us,
                    "provider_closed",
                    "provider input channel closed".to_owned(),
                )
                .await;
                return;
            }
        }
        let endpointing =
            self.endpointing
                .observe(media_time_us, frame.frame_duration_ms, &analysis);
        let publish_telemetry = self
            .telemetry_gate
            .should_publish(media_time_us, endpointing.should_respond);
        let prediction = self
            .envelope(
                "endpointing",
                media_time_us,
                RealtimeEvent::EndpointingPrediction(endpointing.clone()),
            )
            .with_parent(parent_event_id);
        if publish_telemetry {
            self.send(prediction).await;
        }

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
        if publish_telemetry {
            self.send(observation.clone()).await;
        }
        self.apply_observation(observation, media_time_us).await;
    }

    async fn apply_observation(&mut self, observation: EventEnvelope, media_time_us: u64) {
        match self.engine.process(&observation) {
            Ok(decisions) => {
                for mut decision in decisions {
                    decision.sequence = next_sequence(&mut self.sequence);
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
        self.endpointing.reset();
        let generation_id = Uuid::new_v4();
        let prompt_hint = self.repair.take_prompt();
        self.leases.issue(generation_id);
        let conversation_version = self
            .leases
            .active()
            .map(|lease| lease.conversation_version)
            .unwrap_or_default();
        self.engine.mark_response_started(generation_id);
        // Bind every pending (unbound) task to this generation. Tasks
        // admitted between turns now get attached to the upcoming
        // generation so they complete when it finishes.
        self.task_orchestrator
            .bind_pending_to_generation(generation_id);
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
        let ProviderEmission {
            generation_id,
            media_offset_us,
            output,
        } = emission;
        let Some(generation_id) = generation_id else {
            if let ProviderOutput::Event(event) = output {
                let event = self.envelope(provider_stream_id(&event), media_offset_us, event);
                self.send(event).await;
            }
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
        let latency_marks = match &output {
            ProviderOutput::Event(event) => active.latency.observe(event),
            ProviderOutput::Audio(_) => active.latency.observe_audio(),
        };
        let media_time_us = active.base_media_time_us.saturating_add(media_offset_us);
        for mark in latency_marks {
            self.send_latency(media_time_us, generation_id, mark).await;
        }
        // Enforce task deadlines on every provider emission. This
        // piggybacks on existing activity so we don't need a separate
        // timer thread. Expired tasks emit Failure outcomes immediately.
        let now_ms = media_time_us / 1_000;
        let expired = self.task_orchestrator.expire_deadlines(now_ms);
        if !expired.is_empty() {
            self.emit_pending_outcomes(media_time_us, expired).await;
        }
        let is_complete = matches!(
            &output,
            ProviderOutput::Event(RealtimeEvent::ProviderState(state))
                if state.state == ProviderLifecycleState::Complete
        );
        let mut emitted_event_id: Option<Uuid> = None;
        let mut emitted_event_ref: Option<RealtimeEvent> = None;
        match output {
            ProviderOutput::Event(event) => {
                let event_id = Uuid::new_v4();
                let envelope = EventEnvelope::new_with_id(
                    event_id,
                    self.session_id,
                    provider_stream_id(&event),
                    next_sequence(&mut self.sequence),
                    media_time_us,
                    event.clone(),
                )
                .with_generation(generation_id);
                emitted_event_id = Some(event_id);
                emitted_event_ref = Some(event);
                self.send(envelope).await;
            }
            ProviderOutput::Audio(audio) => {
                self.playout.sent(media_time_us);
                let packet = MediaPacket {
                    kind: MediaKind::OutputAudio,
                    sequence: next_sequence(&mut self.sequence),
                    media_time_us,
                    generation_id: Some(generation_id),
                    audio,
                };
                self.send_media(packet);
            }
        }
        // Attach the emitted event as evidence to every task bound to
        // this generation. The evidence kind is classified from the event
        // type — transcript events become Transcript evidence, latency
        // marks become Timing evidence, etc. Tasks bound to other
        // generations are NOT given this evidence.
        if let (Some(event_id), Some(event)) = (emitted_event_id, emitted_event_ref.as_ref()) {
            self.attach_evidence_to_generation(
                generation_id,
                event_id,
                event,
                media_time_us,
            )
            .await;
        }
        if is_complete {
            self.engine.mark_response_complete(generation_id);
            self.active_generation = None;
            // Complete only the tasks bound to this generation. Tasks
            // admitted for a future turn (or bound to a different
            // generation) remain active. This is the correctness fix.
            let outcomes = self
                .task_orchestrator
                .complete_tasks_for_generation(generation_id);
            if !outcomes.is_empty() {
                self.emit_pending_outcomes(media_time_us, outcomes).await;
            }
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
        let Some(expected_stream_id) = client_stream_id(&event.event) else {
            self.send_error(
                event.media_time_us,
                "unsupported_client_event",
                "this event type cannot be sent by a client".to_owned(),
            )
            .await;
            return None;
        };
        if event.stream_id != expected_stream_id {
            self.send_error(
                event.media_time_us,
                "invalid_client_stream",
                format!("expected stream_id {expected_stream_id}"),
            )
            .await;
            return None;
        }
        if let Err(message) =
            self.client_timeline
                .observe(event.sequence, &event.stream_id, event.media_time_us)
        {
            self.send_error(
                event.media_time_us,
                "invalid_client_timeline",
                message.to_owned(),
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
        if self
            .outgoing
            .send(ServerMessage::Control(event))
            .await
            .is_err()
        {
            warn!("session writer closed");
        }
    }

    /// Phase 7: send an outbound event AND buffer its serialized form for
    /// resume replay. The buffer deduplicates by `event_id`, so re-sending
    /// the same event is safe. Buffering happens before the wire write so
    /// a transport error does not corrupt the resume ledger.
    async fn send_and_buffer(&mut self, event: EventEnvelope) {
        let sequence = event.sequence;
        let event_id = event.event_id;
        let Ok(envelope_json) = serde_json::to_string(&event) else {
            warn!("failed to serialize outbound envelope for buffering");
            self.send(event).await;
            return;
        };
        self.task_orchestrator
            .buffer_outbound(sequence, event_id, envelope_json.clone());
        if self
            .outgoing
            .send(ServerMessage::RawText(envelope_json))
            .await
            .is_err()
        {
            warn!("session writer closed");
        }
    }

    fn send_media(&self, packet: MediaPacket) {
        match self.outgoing.try_send(ServerMessage::Media(packet)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                warn!("dropping output media because the client transport is saturated");
            }
            Err(TrySendError::Closed(_)) => {
                warn!("session writer closed");
            }
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

    let provider_manifest = provider.manifest();
    let mut coordinator = SessionCoordinator::new(
        session_id,
        outgoing_sender.clone(),
        provider_input,
        provider_manifest.clone(),
    );
    coordinator.announce(provider_manifest).await;
    loop {
        tokio::select! {
            incoming = transport.incoming.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                match incoming {
                    Ok(Message::Text(text)) => coordinator.handle_text(&text).await,
                    Ok(Message::Binary(binary)) => match MediaPacket::decode(&binary) {
                        Ok(packet) => coordinator.handle_media(packet).await,
                        Err(error) => {
                            coordinator
                                .send_error(0, "invalid_media_packet", error.to_string())
                                .await;
                        }
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Ping(_) | Message::Pong(_)) => {}
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

fn client_stream_id(event: &RealtimeEvent) -> Option<&'static str> {
    match event {
        RealtimeEvent::SessionConfigured(_)
        | RealtimeEvent::Ping
        | RealtimeEvent::SessionResume(_) => Some("session"),
        RealtimeEvent::CapabilityOffer(_) => Some("capability"),
        RealtimeEvent::VisualInput(_) => Some("visual"),
        RealtimeEvent::OutputAudioPlayed(_) => Some("assistant_playout"),
        // Client-owned task events: request, cancel, and resume all flow
        // through the validated client timeline.
        RealtimeEvent::TaskRequested(_) | RealtimeEvent::TaskCancel(_) => Some("tasks"),
        _ => None,
    }
}

fn provider_stream_id(event: &RealtimeEvent) -> &'static str {
    match event {
        RealtimeEvent::OutputAudioCancel(_) => "assistant_audio",
        RealtimeEvent::OutputTextDelta(_) | RealtimeEvent::OutputTextFinal(_) => "assistant_text",
        RealtimeEvent::TaskCreated(_) | RealtimeEvent::TaskResult(_) => "cognition",
        RealtimeEvent::LatencyMark(_) => "telemetry",
        RealtimeEvent::EndpointingPrediction(_) => "endpointing",
        RealtimeEvent::CapabilitySelected(_) => "capability",
        RealtimeEvent::VisualInputAccepted(_) | RealtimeEvent::VisualInputRejected(_) => "visual",
        // Phase 7: gateway-emitted task lifecycle and evidence events.
        RealtimeEvent::TaskAcknowledged(_)
        | RealtimeEvent::TaskOutcome(_) => "tasks",
        RealtimeEvent::EvidenceLink(_) => "evidence",
        _ => "provider",
    }
}

fn next_sequence(sequence: &mut u64) -> u64 {
    *sequence = sequence.saturating_add(1);
    *sequence
}
