use std::{f32::consts::TAU, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, LicenseClass, Modality,
    ModalityCapabilities, OutputAudioFrame, OutputTextDelta, OutputTextFinal, ProviderClass,
    ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent,
};
use thiserror::Error;
use tokio::{sync::mpsc, time::sleep};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ResponseRequest {
    pub session_id: Uuid,
    pub generation_id: Uuid,
    pub prompt: String,
    pub cancellation: CancellationToken,
}

#[derive(Debug, Clone)]
pub struct ProviderEmission {
    pub media_offset_us: u64,
    pub event: RealtimeEvent,
}

pub type ProviderStream = mpsc::Receiver<ProviderEmission>;

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider is unavailable: {0}")]
    Unavailable(String),
    #[error("provider rejected the request: {0}")]
    Rejected(String),
}

#[async_trait]
pub trait RealtimeProvider: Send + Sync {
    fn manifest(&self) -> ProviderManifest;

    async fn start_response(
        &self,
        request: ResponseRequest,
    ) -> Result<ProviderStream, ProviderError>;
}

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

    async fn start_response(
        &self,
        request: ResponseRequest,
    ) -> Result<ProviderStream, ProviderError> {
        let (sender, receiver) = mpsc::channel(32);
        let sample_rate = self.output_sample_rate;
        let frame_duration_ms = self.frame_duration_ms;

        tokio::spawn(async move {
            let response = if request.prompt.trim().is_empty() {
                "Openlive detected a completed speech turn."
            } else {
                "Openlive detected your turn. Speak over this signal to test reversible barge-in."
            };
            let words: Vec<_> = response.split_whitespace().collect();
            let _ = sender
                .send(ProviderEmission {
                    media_offset_us: 0,
                    event: RealtimeEvent::ProviderState(ProviderState {
                        state: "generating".to_owned(),
                    }),
                })
                .await;

            for (index, word) in words.iter().enumerate() {
                if request.cancellation.is_cancelled() {
                    return;
                }
                let suffix = if index + 1 == words.len() { "" } else { " " };
                if sender
                    .send(ProviderEmission {
                        media_offset_us: u64::try_from(index).unwrap_or_default() * 60_000,
                        event: RealtimeEvent::OutputTextDelta(OutputTextDelta {
                            delta: format!("{word}{suffix}"),
                        }),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }

            let frame_count = 45_u64;
            for frame_index in 0..frame_count {
                if request.cancellation.is_cancelled() {
                    return;
                }
                let frequency = if frame_index % 15 < 5 {
                    220.0
                } else if frame_index % 15 < 10 {
                    277.18
                } else {
                    329.63
                };
                let pcm = tone_frame(
                    sample_rate,
                    frame_duration_ms,
                    frequency,
                    frame_index * u64::from(frame_duration_ms),
                );
                if sender
                    .send(ProviderEmission {
                        media_offset_us: frame_index * u64::from(frame_duration_ms) * 1_000,
                        event: RealtimeEvent::OutputAudioFrame(OutputAudioFrame {
                            audio_b64: BASE64.encode(pcm_i16_to_le_bytes(&pcm)),
                            sample_rate,
                            channels: 1,
                            frame_duration_ms,
                        }),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                sleep(Duration::from_millis(u64::from(frame_duration_ms))).await;
            }

            if request.cancellation.is_cancelled() {
                return;
            }
            let _ = sender
                .send(ProviderEmission {
                    media_offset_us: frame_count * u64::from(frame_duration_ms) * 1_000,
                    event: RealtimeEvent::OutputTextFinal(OutputTextFinal {
                        text: response.to_owned(),
                    }),
                })
                .await;
            let _ = sender
                .send(ProviderEmission {
                    media_offset_us: frame_count * u64::from(frame_duration_ms) * 1_000,
                    event: RealtimeEvent::ProviderState(ProviderState {
                        state: "complete".to_owned(),
                    }),
                })
                .await;
        });

        Ok(receiver)
    }
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

    #[test]
    fn manifest_declares_mock_without_gpu_requirement() {
        let manifest = MockDuplexProvider::default().manifest();
        assert_eq!(manifest.provider_class, ProviderClass::Mock);
        assert_eq!(manifest.limits.required_gpu_memory_gb, None);
        assert!(manifest.duplex.continuous_input_while_output);
    }

    #[tokio::test]
    async fn cancellation_stops_stream() {
        let provider = MockDuplexProvider::default();
        let cancellation = CancellationToken::new();
        let mut stream = provider
            .start_response(ResponseRequest {
                session_id: Uuid::new_v4(),
                generation_id: Uuid::new_v4(),
                prompt: "test".to_owned(),
                cancellation: cancellation.clone(),
            })
            .await
            .expect("stream");

        cancellation.cancel();
        while stream.recv().await.is_some() {}
        assert!(stream.is_closed());
    }

    #[test]
    fn tone_frame_has_expected_length() {
        let frame = tone_frame(24_000, 20, 220.0, 0);
        assert_eq!(frame.len(), 480);
    }
}
