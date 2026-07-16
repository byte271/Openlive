//! Moshi / Kyutai-style native duplex provider.
//!
//! Connects to a local Moshi (or Moshi-compatible) WebSocket server and maps
//! bidirectional PCM + optional text frames into the OpenLive provider trait.
//!
//! Wire format (OpenLive dialect — keep server adapters thin):
//! - **Binary**: raw mono PCM16 LE at the negotiated sample rate (default 24 kHz)
//! - **Text JSON**:
//!   - `{ "type": "text", "text": "…" }` assistant transcript deltas
//!   - `{ "type": "text_final", "text": "…" }` final assistant text
//!   - `{ "type": "ready" }` server ready
//!   - `{ "type": "error", "message": "…" }`
//!
//! Run a compatible server (see `docs/open-source-stack.md`) then:
//! ```text
//! cargo run -p openlive-gateway -- --provider moshi --moshi-url ws://127.0.0.1:8998/api/chat
//! ```
//!
//! Credit: product category inspired by [Kyutai Moshi](https://github.com/kyutai-labs/moshi)
//! (Apache-2.0). This adapter is original OpenLive code and does not vendor Moshi.

use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, ErrorEvent, LicenseClass, Modality,
    ModalityCapabilities, OutputTextDelta, OutputTextFinal, PcmAudioFrame, ProviderClass,
    ProviderLifecycleState, ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent,
};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ProviderEmission, ProviderError, ProviderInput, ProviderOutput, ProviderSession,
    ProviderSessionRequest, RealtimeProvider,
};

const OUTPUT_SAMPLE_RATE: u32 = 24_000;
const FRAME_DURATION_MS: u16 = 20;

#[derive(Debug, Clone)]
pub struct MoshiConfig {
    pub url: String,
    pub voice: String,
}

impl Default for MoshiConfig {
    fn default() -> Self {
        Self {
            url: "ws://127.0.0.1:8998/api/chat".to_owned(),
            voice: "default".to_owned(),
        }
    }
}

#[derive(Clone)]
pub struct MoshiProvider {
    config: MoshiConfig,
}

impl MoshiProvider {
    /// # Errors
    /// Returns when the WebSocket URL cannot be parsed.
    pub fn new(config: MoshiConfig) -> Result<Self, ProviderError> {
        Url::parse(&config.url).map_err(|error| {
            ProviderError::InvalidConfiguration(format!("invalid moshi url: {error}"))
        })?;
        Ok(Self { config })
    }
}

#[async_trait]
impl RealtimeProvider for MoshiProvider {
    fn manifest(&self) -> ProviderManifest {
        ProviderManifest {
            id: format!("moshi/{}", self.config.url),
            adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_class: ProviderClass::NativeDuplex,
            license_class: LicenseClass::UserDownload,
            modalities: ModalityCapabilities {
                input: vec![Modality::Audio, Modality::Text],
                output: vec![Modality::Audio, Modality::Text, Modality::State],
            },
            duplex: DuplexCapabilities {
                continuous_input_while_output: true,
                native_turn_policy: true,
                native_barge_in: true,
                state_tokens: true,
            },
            audio: AudioCapabilities {
                input_sample_rates: vec![16_000, 24_000],
                output_sample_rates: vec![OUTPUT_SAMPLE_RATE],
                frame_ms: FRAME_DURATION_MS,
            },
            control: ControlCapabilities {
                text_injection: true,
                context_update: false,
                voice_conditioning: true,
                cancel_generation: true,
                resume_generation: false,
            },
            limits: ProviderLimits {
                max_session_seconds: 7_200,
                required_gpu_memory_gb: Some(8),
            },
        }
    }

    async fn open_session(
        &self,
        _request: ProviderSessionRequest,
    ) -> Result<ProviderSession, ProviderError> {
        let (input_sender, mut input_receiver) = mpsc::channel(256);
        let (output_sender, output_receiver) = mpsc::channel(256);
        let url = self.config.url.clone();
        let voice = self.config.voice.clone();

        tokio::spawn(async move {
            if let Err(error) = run_moshi_session(
                url,
                voice,
                &mut input_receiver,
                output_sender.clone(),
            )
            .await
            {
                let _ = output_sender
                    .send(ProviderEmission {
                        generation_id: None,
                        media_offset_us: 0,
                        output: ProviderOutput::Event(RealtimeEvent::Error(ErrorEvent {
                            code: "moshi_session_failed".to_owned(),
                            message: error,
                            recoverable: true,
                        })),
                    })
                    .await;
            }
        });

        Ok(ProviderSession::new(input_sender, output_receiver))
    }
}

async fn run_moshi_session(
    url: String,
    voice: String,
    input: &mut mpsc::Receiver<ProviderInput>,
    output: mpsc::Sender<ProviderEmission>,
) -> Result<(), String> {
    let (ws, _) = connect_async(&url)
        .await
        .map_err(|error| format!("moshi connect failed: {error}"))?;
    let (mut sink, mut stream) = ws.split();

    // Hello / session config (ignored by servers that do not expect it).
    let hello = serde_json::json!({
        "type": "session",
        "voice": voice,
        "sample_rate": OUTPUT_SAMPLE_RATE,
        "format": "pcm16_le",
    });
    let _ = sink.send(Message::Text(hello.to_string())).await;

    let _ = output
        .send(ProviderEmission {
            generation_id: None,
            media_offset_us: 0,
            output: ProviderOutput::Event(RealtimeEvent::ProviderState(ProviderState {
                state: ProviderLifecycleState::NativeSpeechStarted,
            })),
        })
        .await;

    let cancel = CancellationToken::new();
    let mut active_generation: Option<uuid::Uuid> = None;
    let mut media_offset_us: u64 = 0;

    loop {
        tokio::select! {
            biased;
            maybe_input = input.recv() => {
                match maybe_input {
                    None | Some(ProviderInput::Close) => {
                        cancel.cancel();
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                    Some(ProviderInput::AudioFrame { frame, .. }) => {
                        if sink.send(Message::Binary(frame.pcm)).await.is_err() {
                            break;
                        }
                    }
                    Some(ProviderInput::CommitResponse { generation_id, prompt_hint, .. }) => {
                        active_generation = Some(generation_id);
                        media_offset_us = 0;
                        let msg = serde_json::json!({
                            "type": "commit",
                            "generation_id": generation_id,
                            "prompt_hint": prompt_hint,
                        });
                        let _ = sink.send(Message::Text(msg.to_string())).await;
                        let _ = output.send(ProviderEmission {
                            generation_id: Some(generation_id),
                            media_offset_us: 0,
                            output: ProviderOutput::Event(RealtimeEvent::ProviderState(ProviderState {
                                state: ProviderLifecycleState::Generating,
                            })),
                        }).await;
                    }
                    Some(ProviderInput::CancelGeneration { generation_id }) => {
                        let msg = serde_json::json!({
                            "type": "cancel",
                            "generation_id": generation_id,
                        });
                        let _ = sink.send(Message::Text(msg.to_string())).await;
                        if active_generation == Some(generation_id) {
                            active_generation = None;
                        }
                    }
                }
            }
            maybe_msg = stream.next() => {
                match maybe_msg {
                    None => break,
                    Some(Err(error)) => {
                        return Err(format!("moshi websocket error: {error}"));
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let gen = active_generation.unwrap_or_else(uuid::Uuid::new_v4);
                        active_generation = Some(gen);
                        let samples = bytes.len() / 2;
                        let duration_us = samples as u64 * 1_000_000 / u64::from(OUTPUT_SAMPLE_RATE);
                        let frame = PcmAudioFrame {
                            pcm: bytes,
                            sample_rate: OUTPUT_SAMPLE_RATE,
                            channels: 1,
                            frame_duration_ms: FRAME_DURATION_MS,
                            client_speech_probability: None,
                            client_output_level: None,
                            client_echo_probability: None,
                        };
                        if output.send(ProviderEmission {
                            generation_id: Some(gen),
                            media_offset_us,
                            output: ProviderOutput::Audio(frame),
                        }).await.is_err() {
                            break;
                        }
                        media_offset_us = media_offset_us.saturating_add(duration_us);
                    }
                    Some(Ok(Message::Text(text))) => {
                        handle_moshi_text(&text, &output, &mut active_generation, media_offset_us).await;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = sink.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                }
            }
            () = tokio::time::sleep(Duration::from_secs(3600)) => {
                // keep select alive; real idle handled by Close
            }
        }
    }
    Ok(())
}

async fn handle_moshi_text(
    text: &str,
    output: &mpsc::Sender<ProviderEmission>,
    active_generation: &mut Option<uuid::Uuid>,
    media_offset_us: u64,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let kind = value.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
    let gen = active_generation.unwrap_or_else(uuid::Uuid::new_v4);
    *active_generation = Some(gen);

    match kind {
        "text" | "transcript" | "assistant_text" => {
            if let Some(delta) = value
                .get("text")
                .or_else(|| value.get("delta"))
                .and_then(serde_json::Value::as_str)
            {
                let _ = output
                    .send(ProviderEmission {
                        generation_id: Some(gen),
                        media_offset_us,
                        output: ProviderOutput::Event(RealtimeEvent::OutputTextDelta(
                            OutputTextDelta {
                                delta: delta.to_owned(),
                            },
                        )),
                    })
                    .await;
            }
        }
        "text_final" | "final" => {
            if let Some(final_text) = value.get("text").and_then(serde_json::Value::as_str) {
                let _ = output
                    .send(ProviderEmission {
                        generation_id: Some(gen),
                        media_offset_us,
                        output: ProviderOutput::Event(RealtimeEvent::OutputTextFinal(
                            OutputTextFinal {
                                text: final_text.to_owned(),
                            },
                        )),
                    })
                    .await;
                let _ = output
                    .send(ProviderEmission {
                        generation_id: Some(gen),
                        media_offset_us,
                        output: ProviderOutput::Event(RealtimeEvent::ProviderState(ProviderState {
                            state: ProviderLifecycleState::Complete,
                        })),
                    })
                    .await;
            }
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("moshi error")
                .to_owned();
            let _ = output
                .send(ProviderEmission {
                    generation_id: Some(gen),
                    media_offset_us,
                    output: ProviderOutput::Event(RealtimeEvent::Error(ErrorEvent {
                        code: "moshi_error".to_owned(),
                        message,
                        recoverable: true,
                    })),
                })
                .await;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_url_host_parse() {
        let err = MoshiProvider::new(MoshiConfig {
            url: "not a url".to_owned(),
            voice: "x".to_owned(),
        });
        assert!(err.is_err());
    }

    #[test]
    fn manifest_is_native_duplex() {
        let provider = MoshiProvider::new(MoshiConfig::default()).expect("url");
        assert_eq!(provider.manifest().provider_class, ProviderClass::NativeDuplex);
        assert!(provider.manifest().duplex.native_barge_in);
    }
}
