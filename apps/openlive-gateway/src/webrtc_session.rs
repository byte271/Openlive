//! Bridge a gateway-native WebRTC peer onto a provider session with endpointing.
//!
//! Control JSON on `openlive-events` uses EventEnvelope (same as WebSocket).
//! Binary on `openlive-media` carries MediaPacket frames (or raw PCM16).

use std::sync::Arc;

use openlive_audio::{AcousticFrontend, AudioAnalysis, EndpointingTracker};
use openlive_protocol::{
    CapabilitySelected, EventEnvelope, InteractionAction, InteractionDecision, MediaKind,
    MediaPacket, MediaTransport, Modality, Observation, OutputAudioPlayed, ProviderLifecycleState,
    ProviderManifest, RealtimeEvent, SessionCreated, SessionConfigured, UserTranscriptDelta,
    VisualInputMode, PROTOCOL_REVISION, PROTOCOL_VERSION,
};
use openlive_provider::{
    ProviderEmission, ProviderInput, ProviderOutput, ProviderSessionRequest, RealtimeProvider,
};
use tracing::{info, warn};
use uuid::Uuid;

use crate::webrtc_media::{PeerInbound, WebRtcPeerSession};

struct BridgeState {
    session_id: Uuid,
    sequence: u64,
    conversation_version: u64,
    active_generation: Option<Uuid>,
    endpointing: EndpointingTracker,
    acoustics: AcousticFrontend,
    latest_semantic: Option<f32>,
    last_user_text: String,
    media_time_us: u64,
    manifest: ProviderManifest,
}

/// Run until the peer closes.
pub async fn run_webrtc_peer(mut peer: WebRtcPeerSession, provider: Arc<dyn RealtimeProvider>) {
    let session_id = peer.id;
    info!(%session_id, "webrtc provider bridge starting");

    let provider_session = match provider
        .open_session(ProviderSessionRequest { session_id })
        .await
    {
        Ok(s) => s,
        Err(error) => {
            warn!(%session_id, %error, "provider open failed for webrtc peer");
            peer.close().await;
            return;
        }
    };
    let (provider_in, mut provider_out) = provider_session.into_parts();
    let manifest = provider.manifest();
    let input_rate = *manifest.audio.input_sample_rates.first().unwrap_or(&16_000);
    let output_rate = *manifest.audio.output_sample_rates.first().unwrap_or(&24_000);

    let mut state = BridgeState {
        session_id,
        sequence: 0,
        conversation_version: 1,
        active_generation: None,
        endpointing: EndpointingTracker::default(),
        acoustics: AcousticFrontend::default(),
        latest_semantic: None,
        last_user_text: String::new(),
        media_time_us: 0,
        manifest: manifest.clone(),
    };

    let _ = send_event(
        &mut peer,
        &mut state,
        "session",
        0,
        RealtimeEvent::SessionCreated(SessionCreated {
            model: manifest.id.clone(),
            provider_class: manifest.provider_class,
            input_sample_rate: input_rate,
            output_sample_rate: output_rate,
            media_transport: MediaTransport::WebsocketBinaryPcm,
        }),
        None,
    )
    .await;

    loop {
        tokio::select! {
            inbound = peer.recv() => {
                match inbound {
                    None | Some(PeerInbound::Closed) => break,
                    Some(PeerInbound::ControlText(text)) => {
                        handle_inbound_control(&mut peer, &mut state, &provider_in, &text).await;
                    }
                    Some(PeerInbound::MediaBinary(bytes)) => {
                        handle_inbound_media(&mut peer, &mut state, &provider_in, bytes).await;
                    }
                }
            }
            emission = provider_out.recv() => {
                match emission {
                    None => break,
                    Some(ProviderEmission { generation_id, media_offset_us, output }) => {
                        if let (Some(active), Some(gid)) = (state.active_generation, generation_id) {
                            if gid != active {
                                continue;
                            }
                        }
                        match output {
                            ProviderOutput::Event(event) => {
                                let complete = matches!(
                                    &event,
                                    RealtimeEvent::ProviderState(s)
                                        if s.state == ProviderLifecycleState::Complete
                                );
                                let _ = send_event(
                                    &mut peer,
                                    &mut state,
                                    stream_for(&event),
                                    media_offset_us,
                                    event,
                                    generation_id,
                                ).await;
                                if complete {
                                    state.active_generation = None;
                                    state.endpointing = EndpointingTracker::default();
                                    state.latest_semantic = None;
                                }
                            }
                            ProviderOutput::Audio(audio) => {
                                state.sequence = state.sequence.saturating_add(1);
                                let packet = MediaPacket {
                                    kind: MediaKind::OutputAudio,
                                    sequence: state.sequence,
                                    media_time_us: media_offset_us,
                                    generation_id,
                                    audio,
                                };
                                peer.send_media(packet.encode()).await;
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = provider_in.send(ProviderInput::Close).await;
    let peer_id = peer.id;
    peer.close().await;
    info!(%session_id, %peer_id, "webrtc provider bridge stopped");
}

async fn handle_inbound_control(
    peer: &mut WebRtcPeerSession,
    state: &mut BridgeState,
    provider_in: &tokio::sync::mpsc::Sender<ProviderInput>,
    text: &str,
) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        match value.get("type").and_then(|t| t.as_str()) {
            Some("commit") => {
                let hint = value
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or(state.last_user_text.as_str())
                    .to_owned();
                commit_response(state, provider_in, hint).await;
                return;
            }
            Some("cancel") => {
                if let Some(gid) = state.active_generation.take() {
                    let _ = provider_in
                        .send(ProviderInput::CancelGeneration {
                            generation_id: gid,
                        })
                        .await;
                }
                return;
            }
            _ => {}
        }
    }

    let Ok(envelope) = serde_json::from_str::<EventEnvelope>(text) else {
        return;
    };
    if envelope.protocol_version != PROTOCOL_VERSION {
        warn!(
            expected = PROTOCOL_VERSION,
            got = %envelope.protocol_version,
            "webrtc protocol mismatch"
        );
    }
    state.media_time_us = state.media_time_us.max(envelope.media_time_us);

    match envelope.event {
        RealtimeEvent::SessionConfigured(SessionConfigured { .. }) => {
            let _ = send_event(
                peer,
                state,
                "session",
                envelope.media_time_us,
                RealtimeEvent::Pong,
                None,
            )
            .await;
        }
        RealtimeEvent::UserTranscriptDelta(UserTranscriptDelta { text, is_final }) => {
            state.last_user_text = text.clone();
            state.latest_semantic = Some(semantic_score(&text));
            if is_final && !text.trim().is_empty() {
                commit_response(state, provider_in, text).await;
            }
        }
        RealtimeEvent::CapabilityOffer(offer) => {
            let selected = CapabilitySelected {
                protocol_revision: PROTOCOL_REVISION.min(offer.protocol_revision),
                provider_manifest: state.manifest.clone(),
                selected_input: vec![Modality::Audio, Modality::Text],
                selected_output: vec![Modality::Audio, Modality::Text, Modality::State],
                visual_mode: VisualInputMode::ExplicitSnapshot,
                resume_supported: true,
                warnings: vec!["webrtc data-channel media path".into()],
            };
            let _ = send_event(
                peer,
                state,
                "capability",
                envelope.media_time_us,
                RealtimeEvent::CapabilitySelected(selected),
                None,
            )
            .await;
        }
        RealtimeEvent::OutputAudioPlayed(OutputAudioPlayed { .. }) => {}
        RealtimeEvent::Ping => {
            let _ = send_event(
                peer,
                state,
                "session",
                envelope.media_time_us,
                RealtimeEvent::Pong,
                None,
            )
            .await;
        }
        _ => {}
    }
}

async fn handle_inbound_media(
    peer: &mut WebRtcPeerSession,
    state: &mut BridgeState,
    provider_in: &tokio::sync::mpsc::Sender<ProviderInput>,
    bytes: Vec<u8>,
) {
    let (frame, media_time_us, speech_hint) = if let Ok(packet) = MediaPacket::decode(&bytes) {
        if !matches!(packet.kind, MediaKind::InputAudio) {
            return;
        }
        let speech = packet.audio.client_speech_probability;
        (packet.audio, packet.media_time_us, speech)
    } else if bytes.len() >= 2 {
        use openlive_protocol::PcmAudioFrame;
        (
            PcmAudioFrame {
                pcm: bytes,
                sample_rate: 16_000,
                channels: 1,
                frame_duration_ms: 20,
                client_speech_probability: None,
                client_output_level: None,
                client_echo_probability: None,
            },
            state.media_time_us.saturating_add(20_000),
            None,
        )
    } else {
        return;
    };

    state.media_time_us = state.media_time_us.max(media_time_us);

    let _ = provider_in
        .send(ProviderInput::AudioFrame {
            media_time_us,
            frame: frame.clone(),
        })
        .await;

    let analysis = match state
        .acoustics
        .analyze(&frame, state.active_generation.is_some())
    {
        Ok(a) => a,
        Err(_) => AudioAnalysis {
            speech_probability: speech_hint.unwrap_or(0.0),
            echo_probability: 0.0,
            target_speaker_probability: speech_hint.unwrap_or(0.0),
            rms: 0.01,
        },
    };
    let prediction = state.endpointing.observe_with_semantic(
        media_time_us,
        frame.frame_duration_ms,
        &analysis,
        state.latest_semantic,
    );

    let _ = send_event(
        peer,
        state,
        "endpointing",
        media_time_us,
        RealtimeEvent::Observation(Observation {
            speech_probability: analysis.speech_probability,
            echo_probability: analysis.echo_probability,
            target_speaker_probability: analysis.target_speaker_probability,
            turn_completion_confidence: prediction.turn_completion_confidence,
            prosodic_finality: prediction.prosodic_finality,
            semantic_completion: state.latest_semantic,
        }),
        None,
    )
    .await;

    if prediction.should_respond && state.active_generation.is_none() {
        // Never invent a fake prompt — wait for client ASR text.
        if state.last_user_text.trim().is_empty() {
            return;
        }
        let hint = state.last_user_text.clone();
        let _ = send_event(
            peer,
            state,
            "interaction",
            media_time_us,
            RealtimeEvent::InteractionDecision(InteractionDecision {
                action: InteractionAction::StartResponse,
                confidence: prediction.turn_completion_confidence,
                reversible: false,
                reason: prediction.reason.clone(),
                evidence_event_ids: vec![],
            }),
            None,
        )
        .await;
        commit_response(state, provider_in, hint).await;
        // Prevent re-firing the same utterance.
        state.last_user_text.clear();
    }
}

async fn commit_response(
    state: &mut BridgeState,
    provider_in: &tokio::sync::mpsc::Sender<ProviderInput>,
    prompt_hint: String,
) {
    if state.active_generation.is_some() {
        return;
    }
    let generation_id = Uuid::new_v4();
    state.active_generation = Some(generation_id);
    state.conversation_version = state.conversation_version.saturating_add(1);
    state.endpointing = EndpointingTracker::default();
    let _ = provider_in
        .send(ProviderInput::CommitResponse {
            generation_id,
            conversation_version: state.conversation_version,
            media_time_us: state.media_time_us,
            prompt_hint,
        })
        .await;
}

async fn send_event(
    peer: &mut WebRtcPeerSession,
    state: &mut BridgeState,
    stream_id: &str,
    media_time_us: u64,
    event: RealtimeEvent,
    generation_id: Option<Uuid>,
) -> Uuid {
    state.sequence = state.sequence.saturating_add(1);
    let mut envelope = EventEnvelope::new(
        state.session_id,
        stream_id,
        state.sequence,
        media_time_us,
        event,
    );
    envelope.generation_id = generation_id;
    let event_id = envelope.event_id;
    if let Ok(json) = serde_json::to_string(&envelope) {
        peer.send_control(json).await;
    }
    event_id
}

fn stream_for(event: &RealtimeEvent) -> &'static str {
    match event {
        RealtimeEvent::OutputTextDelta(_) | RealtimeEvent::OutputTextFinal(_) => "assistant_text",
        RealtimeEvent::ProviderState(_) => "provider",
        RealtimeEvent::TaskCreated(_) | RealtimeEvent::TaskResult(_) => "cognition",
        RealtimeEvent::VisualCard(_) => "visual",
        RealtimeEvent::Observation(_) => "endpointing",
        RealtimeEvent::InteractionDecision(_) => "interaction",
        _ => "provider",
    }
}

fn semantic_score(text: &str) -> f32 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if trimmed.ends_with('.') || trimmed.ends_with('?') || trimmed.ends_with('!') {
        return 0.95;
    }
    let words = trimmed.split_whitespace().count();
    (words as f32 / 6.0).clamp(0.2, 0.85)
}

#[cfg(test)]
mod tests {
    use super::semantic_score;

    #[test]
    fn semantic_score_high_on_terminal_punct() {
        assert!(semantic_score("Hello there.") >= 0.9);
        assert!(semantic_score("hi") < 0.9);
    }
}
