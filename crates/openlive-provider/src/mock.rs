use std::{f32::consts::TAU, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, LicenseClass, Modality,
    ModalityCapabilities, OutputAudioFrame, OutputTextDelta, OutputTextFinal, ProviderClass,
    ProviderLifecycleState, ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent,
};
use tokio::{sync::mpsc, time::sleep};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderEmission, ProviderError, ProviderInput, ProviderSession, ProviderSessionRequest,
    RealtimeProvider,
};

#[derive(Debug, Clone)]
pub struct MockDuplexProvider {
    output_sample_rate: u32,
    frame_duration_ms: u16,
}

impl Default for MockDuplexProvider {
    fn default() -> Self {
        Self {
            output_sample_rate: 24_000,
            frame_duration_ms: 20,
        }
    }
}

#[async_trait]
impl RealtimeProvider for MockDuplexProvider {
    fn manifest(&self) -> ProviderManifest {
        ProviderManifest {
            id: "openlive/mock-duplex".to_owned(),
            adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_class: ProviderClass::Mock,
            license_class: LicenseClass::Redistributable,
            modalities: ModalityCapabilities {
                input: vec![Modality::Audio, Modality::Text],
                output: vec![Modality::Audio, Modality::Text, Modality::State],
            },
            duplex: DuplexCapabilities {
                continuous_input_while_output: true,
                native_turn_policy: false,
                native_barge_in: true,
                state_tokens: true,
            },
            audio: AudioCapabilities {
                input_sample_rates: vec![16_000, 24_000, 48_000],
                output_sample_rates: vec![self.output_sample_rate],
                frame_ms: self.frame_duration_ms,
            },
            control: ControlCapabilities {
                text_injection: true,
                context_update: false,
                voice_conditioning: false,
                cancel_generation: true,
                resume_generation: false,
            },
            limits: ProviderLimits {
                max_session_seconds: 3_600,
                required_gpu_memory_gb: None,
            },
        }
    }

    async fn open_session(
        &self,
        _request: ProviderSessionRequest,
    ) -> Result<ProviderSession, ProviderError> {
        let (input_sender, mut input_receiver) = mpsc::channel(128);
        let (output_sender, output_receiver) = mpsc::channel(128);
        let sample_rate = self.output_sample_rate;
        let frame_duration_ms = self.frame_duration_ms;

        tokio::spawn(async move {
            let mut active: Option<(uuid::Uuid, CancellationToken)> = None;
            while let Some(input) = input_receiver.recv().await {
                match input {
                    ProviderInput::AudioFrame { .. } => {}
                    ProviderInput::CommitResponse {
                        generation_id,
                        prompt_hint,
                        ..
                    } => {
                        cancel_active(&mut active);
                        let cancellation = CancellationToken::new();
                        active = Some((generation_id, cancellation.clone()));
                        tokio::spawn(generate_mock_response(
                            output_sender.clone(),
                            generation_id,
                            prompt_hint,
                            sample_rate,
                            frame_duration_ms,
                            cancellation,
                        ));
                    }
                    ProviderInput::CancelGeneration { generation_id } => {
                        if active
                            .as_ref()
                            .is_some_and(|(active_id, _)| *active_id == generation_id)
                        {
                            cancel_active(&mut active);
                        }
                    }
                    ProviderInput::Close => {
                        cancel_active(&mut active);
                        break;
                    }
                }
            }
        });

        Ok(ProviderSession::new(input_sender, output_receiver))
    }
}

fn cancel_active(active: &mut Option<(uuid::Uuid, CancellationToken)>) {
    if let Some((_, cancellation)) = active.take() {
        cancellation.cancel();
    }
}

async fn generate_mock_response(
    sender: mpsc::Sender<ProviderEmission>,
    generation_id: uuid::Uuid,
    prompt: String,
    sample_rate: u32,
    frame_duration_ms: u16,
    cancellation: CancellationToken,
) {
    let response = if prompt.trim().is_empty() {
        "Openlive detected a completed speech turn.".to_owned()
    } else {
        prompt
    };
    if send(
        &sender,
        generation_id,
        0,
        RealtimeEvent::ProviderState(ProviderState {
            state: ProviderLifecycleState::Generating,
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    for (index, word) in response.split_whitespace().enumerate() {
        if cancellation.is_cancelled() {
            return;
        }
        let offset = u64::try_from(index).unwrap_or_default() * 60_000;
        let prefix = if index == 0 { "" } else { " " };
        if send(
            &sender,
            generation_id,
            offset,
            RealtimeEvent::OutputTextDelta(OutputTextDelta {
                delta: format!("{prefix}{word}"),
            }),
        )
        .await
        .is_err()
        {
            return;
        }
    }

    let frame_count = 45_u64;
    for frame_index in 0..frame_count {
        if cancellation.is_cancelled() {
            return;
        }
        let frequency = match frame_index % 15 {
            0..=4 => 220.0,
            5..=9 => 277.18,
            _ => 329.63,
        };
        let pcm = tone_frame(
            sample_rate,
            frame_duration_ms,
            frequency,
            frame_index * u64::from(frame_duration_ms),
        );
        if send(
            &sender,
            generation_id,
            frame_index * u64::from(frame_duration_ms) * 1_000,
            RealtimeEvent::OutputAudioFrame(OutputAudioFrame {
                audio_b64: BASE64.encode(pcm_i16_to_le_bytes(&pcm)),
                sample_rate,
                channels: 1,
                frame_duration_ms,
            }),
        )
        .await
        .is_err()
        {
            return;
        }
        sleep(Duration::from_millis(u64::from(frame_duration_ms))).await;
    }

    if cancellation.is_cancelled() {
        return;
    }
    let final_offset = frame_count * u64::from(frame_duration_ms) * 1_000;
    let _ = send(
        &sender,
        generation_id,
        final_offset,
        RealtimeEvent::OutputTextFinal(OutputTextFinal { text: response }),
    )
    .await;
    let _ = send(
        &sender,
        generation_id,
        final_offset,
        RealtimeEvent::ProviderState(ProviderState {
            state: ProviderLifecycleState::Complete,
        }),
    )
    .await;
}

async fn send(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: uuid::Uuid,
    media_offset_us: u64,
    event: RealtimeEvent,
) -> Result<(), mpsc::error::SendError<ProviderEmission>> {
    sender
        .send(ProviderEmission {
            generation_id: Some(generation_id),
            media_offset_us,
            event,
        })
        .await
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn tone_frame(
    sample_rate: u32,
    frame_duration_ms: u16,
    frequency_hz: f32,
    position_ms: u64,
) -> Vec<i16> {
    let sample_count =
        usize::try_from(u64::from(sample_rate) * u64::from(frame_duration_ms) / 1_000)
            .unwrap_or_default();
    let start_sample = position_ms * u64::from(sample_rate) / 1_000;

    (0..sample_count)
        .map(|index| {
            let absolute_sample = start_sample + u64::try_from(index).unwrap_or_default();
            let phase = absolute_sample as f32 / sample_rate as f32 * frequency_hz * TAU;
            let edge = index.min(sample_count.saturating_sub(index + 1));
            let envelope = (edge as f32 / 80.0).min(1.0);
            (phase.sin() * envelope * 4_200.0) as i16
        })
        .collect()
}

fn pcm_i16_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn manifest_declares_mock_without_gpu_requirement() {
        let manifest = MockDuplexProvider::default().manifest();
        assert_eq!(manifest.provider_class, ProviderClass::Mock);
        assert_eq!(manifest.limits.required_gpu_memory_gb, None);
        assert!(manifest.duplex.continuous_input_while_output);
    }

    #[tokio::test]
    async fn session_emits_generation_events() {
        let provider = MockDuplexProvider::default();
        let session = provider
            .open_session(ProviderSessionRequest {
                session_id: Uuid::new_v4(),
            })
            .await
            .expect("session");
        let (input, mut output) = session.into_parts();
        let generation_id = Uuid::new_v4();
        input
            .send(ProviderInput::CommitResponse {
                generation_id,
                conversation_version: 1,
                media_time_us: 0,
                prompt_hint: "test".to_owned(),
            })
            .await
            .expect("commit");
        let emission = output.recv().await.expect("emission");
        assert_eq!(emission.generation_id, Some(generation_id));
    }

    #[test]
    fn tone_frame_has_expected_length() {
        let frame = tone_frame(24_000, 20, 220.0, 0);
        assert_eq!(frame.len(), 480);
    }
}
