use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{Sink, SinkExt, StreamExt};
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, ErrorEvent, LicenseClass, Modality,
    ModalityCapabilities, OutputAudioFrame, OutputTextDelta, OutputTextFinal, ProviderClass,
    ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        Error as WebSocketError, Message,
    },
};
use url::Url;
use uuid::Uuid;

use crate::{
    ProviderEmission, ProviderError, ProviderInput, ProviderSession, ProviderSessionRequest,
    RealtimeProvider,
};

const SAMPLE_RATE: u32 = 24_000;
const DEFAULT_FRAME_DURATION_MS: u16 = 20;

#[derive(Debug, Clone)]
pub struct OpenAiRealtimeConfig {
    pub url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub voice: String,
    pub instructions: String,
}

impl Default for OpenAiRealtimeConfig {
    fn default() -> Self {
        Self {
            url: "wss://api.openai.com/v1/realtime".to_owned(),
            api_key: None,
            model: "gpt-4o-realtime-preview".to_owned(),
            voice: "alloy".to_owned(),
            instructions: "Respond naturally and concisely in spoken conversation.".to_owned(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiRealtimeProvider {
    config: OpenAiRealtimeConfig,
}

impl OpenAiRealtimeProvider {
    /// Creates an OpenAI-compatible native realtime speech provider.
    ///
    /// # Errors
    ///
    /// Returns an error when the WebSocket URL or model is empty.
    pub fn new(config: OpenAiRealtimeConfig) -> Result<Self, ProviderError> {
        if config.url.trim().is_empty() {
            return Err(ProviderError::InvalidConfiguration(
                "realtime URL cannot be empty".to_owned(),
            ));
        }
        if config.model.trim().is_empty() {
            return Err(ProviderError::InvalidConfiguration(
                "realtime model cannot be empty".to_owned(),
            ));
        }
        Ok(Self { config })
    }
}

#[async_trait]
impl RealtimeProvider for OpenAiRealtimeProvider {
    fn manifest(&self) -> ProviderManifest {
        ProviderManifest {
            id: format!("openai-realtime/{}", self.config.model),
            adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_class: ProviderClass::NativeDuplex,
            license_class: LicenseClass::HostedOnly,
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
                input_sample_rates: vec![SAMPLE_RATE],
                output_sample_rates: vec![SAMPLE_RATE],
                frame_ms: DEFAULT_FRAME_DURATION_MS,
            },
            control: ControlCapabilities {
                text_injection: true,
                context_update: true,
                voice_conditioning: true,
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
        let request = connection_request(&self.config)?;
        let (websocket, _) = connect_async(request)
            .await
            .map_err(|error| ProviderError::Unavailable(error.to_string()))?;
        let (input_sender, input_receiver) = mpsc::channel(128);
        let (output_sender, output_receiver) = mpsc::channel(128);
        let config = self.config.clone();

        tokio::spawn(run_realtime_session(
            websocket,
            input_receiver,
            output_sender,
            config,
        ));
        Ok(ProviderSession::new(input_sender, output_receiver))
    }
}

struct ActiveResponse {
    generation_id: Uuid,
    output_offset_us: u64,
    transcript: String,
}

async fn run_realtime_session<S>(
    websocket: tokio_tungstenite::WebSocketStream<S>,
    mut input_receiver: mpsc::Receiver<ProviderInput>,
    output_sender: mpsc::Sender<ProviderEmission>,
    config: OpenAiRealtimeConfig,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut websocket_sender, mut websocket_receiver) = websocket.split();
    if send_json(
        &mut websocket_sender,
        &json!({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": config.instructions,
                "voice": config.voice,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "turn_detection": null
            }
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    let mut active: Option<ActiveResponse> = None;
    loop {
        tokio::select! {
            input = input_receiver.recv() => {
                let Some(input) = input else {
                    break;
                };
                if handle_input(input, &mut active, &mut websocket_sender, &output_sender)
                    .await
                    .is_err()
                {
                    break;
                }
            }
            message = websocket_receiver.next() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    Ok(Message::Text(text)) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&text) {
                            handle_server_event(event, &mut active, &output_sender).await;
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        if websocket_sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_)) => {}
                }
            }
        }
    }
    let _ = websocket_sender.close().await;
}

async fn handle_input<S>(
    input: ProviderInput,
    active: &mut Option<ActiveResponse>,
    websocket_sender: &mut S,
    output_sender: &mpsc::Sender<ProviderEmission>,
) -> Result<(), WebSocketError>
where
    S: Sink<Message, Error = WebSocketError> + Unpin,
{
    match input {
        ProviderInput::AudioFrame {
            media_time_us: _,
            frame,
        } => {
            if frame.sample_rate != SAMPLE_RATE || frame.channels != 1 {
                send_error(
                    output_sender,
                    active.as_ref().map(|response| response.generation_id),
                    0,
                    "unsupported_audio_format",
                    "native realtime provider requires 24 kHz mono PCM".to_owned(),
                )
                .await;
                return Ok(());
            }
            send_json(
                websocket_sender,
                &json!({
                    "type": "input_audio_buffer.append",
                    "audio": frame.audio_b64
                }),
            )
            .await?;
        }
        ProviderInput::CommitResponse {
            generation_id,
            media_time_us: _,
            prompt_hint: _,
        } => {
            *active = Some(ActiveResponse {
                generation_id,
                output_offset_us: 0,
                transcript: String::new(),
            });
            send_json(
                websocket_sender,
                &json!({"type": "input_audio_buffer.commit"}),
            )
            .await?;
            send_json(
                websocket_sender,
                &json!({
                    "type": "response.create",
                    "response": {
                        "modalities": ["text", "audio"]
                    }
                }),
            )
            .await?;
        }
        ProviderInput::CancelGeneration { generation_id } => {
            if active
                .as_ref()
                .is_some_and(|response| response.generation_id == generation_id)
            {
                send_json(websocket_sender, &json!({"type": "response.cancel"})).await?;
                *active = None;
            }
        }
        ProviderInput::Close => {
            websocket_sender.close().await?;
        }
    }
    Ok(())
}

async fn handle_server_event(
    event: Value,
    active: &mut Option<ActiveResponse>,
    output_sender: &mpsc::Sender<ProviderEmission>,
) {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "response.created" => {
            if let Some(response) = active.as_ref() {
                let _ = emit(
                    output_sender,
                    response,
                    RealtimeEvent::ProviderState(ProviderState {
                        state: "generating".to_owned(),
                    }),
                )
                .await;
            }
        }
        "response.audio.delta" | "response.output_audio.delta" => {
            emit_audio_delta(&event, active, output_sender).await;
        }
        "response.audio_transcript.delta"
        | "response.output_audio_transcript.delta"
        | "response.text.delta"
        | "response.output_text.delta" => {
            emit_text_delta(&event, active, output_sender).await;
        }
        "response.done" => {
            finish_response(active, output_sender).await;
        }
        "input_audio_buffer.speech_started" => {
            if let Some(response) = active.as_ref() {
                let _ = emit(
                    output_sender,
                    response,
                    RealtimeEvent::ProviderState(ProviderState {
                        state: "native_speech_started".to_owned(),
                    }),
                )
                .await;
            }
        }
        "error" => {
            emit_provider_error(&event, active.as_ref(), output_sender).await;
        }
        _ => {}
    }
}

async fn emit_audio_delta(
    event: &Value,
    active: &mut Option<ActiveResponse>,
    output_sender: &mpsc::Sender<ProviderEmission>,
) {
    let Some(audio_b64) = event.get("delta").and_then(Value::as_str) else {
        return;
    };
    let Some(response) = active.as_mut() else {
        return;
    };
    let duration_us = pcm_duration_us(audio_b64);
    let emission = ProviderEmission {
        generation_id: Some(response.generation_id),
        media_offset_us: response.output_offset_us,
        event: RealtimeEvent::OutputAudioFrame(OutputAudioFrame {
            audio_b64: audio_b64.to_owned(),
            sample_rate: SAMPLE_RATE,
            channels: 1,
            frame_duration_ms: duration_ms(duration_us),
        }),
    };
    response.output_offset_us = response.output_offset_us.saturating_add(duration_us);
    let _ = output_sender.send(emission).await;
}

async fn emit_text_delta(
    event: &Value,
    active: &mut Option<ActiveResponse>,
    output_sender: &mpsc::Sender<ProviderEmission>,
) {
    let Some(delta) = event.get("delta").and_then(Value::as_str) else {
        return;
    };
    let Some(response) = active.as_mut() else {
        return;
    };
    response.transcript.push_str(delta);
    let _ = output_sender
        .send(ProviderEmission {
            generation_id: Some(response.generation_id),
            media_offset_us: response.output_offset_us,
            event: RealtimeEvent::OutputTextDelta(OutputTextDelta {
                delta: delta.to_owned(),
            }),
        })
        .await;
}

async fn finish_response(
    active: &mut Option<ActiveResponse>,
    output_sender: &mpsc::Sender<ProviderEmission>,
) {
    let Some(response) = active.take() else {
        return;
    };
    let _ = output_sender
        .send(ProviderEmission {
            generation_id: Some(response.generation_id),
            media_offset_us: response.output_offset_us,
            event: RealtimeEvent::OutputTextFinal(OutputTextFinal {
                text: response.transcript,
            }),
        })
        .await;
    let _ = output_sender
        .send(ProviderEmission {
            generation_id: Some(response.generation_id),
            media_offset_us: response.output_offset_us,
            event: RealtimeEvent::ProviderState(ProviderState {
                state: "complete".to_owned(),
            }),
        })
        .await;
}

async fn emit_provider_error(
    event: &Value,
    active: Option<&ActiveResponse>,
    output_sender: &mpsc::Sender<ProviderEmission>,
) {
    let message = event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("native realtime endpoint returned an error")
        .to_owned();
    let generation_id = active.map(|response| response.generation_id);
    send_error(
        output_sender,
        generation_id,
        0,
        "realtime_provider_error",
        message,
    )
    .await;
}

async fn emit(
    sender: &mpsc::Sender<ProviderEmission>,
    response: &ActiveResponse,
    event: RealtimeEvent,
) -> Result<(), mpsc::error::SendError<ProviderEmission>> {
    sender
        .send(ProviderEmission {
            generation_id: Some(response.generation_id),
            media_offset_us: response.output_offset_us,
            event,
        })
        .await
}

async fn send_error(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Option<Uuid>,
    media_time_us: u64,
    code: &str,
    message: String,
) {
    let _ = sender
        .send(ProviderEmission {
            generation_id,
            media_offset_us: media_time_us,
            event: RealtimeEvent::Error(ErrorEvent {
                code: code.to_owned(),
                message,
                recoverable: true,
            }),
        })
        .await;
}

async fn send_json<S>(sender: &mut S, value: &Value) -> Result<(), WebSocketError>
where
    S: Sink<Message, Error = WebSocketError> + Unpin,
{
    sender.send(Message::Text(value.to_string())).await
}

fn connection_request(
    config: &OpenAiRealtimeConfig,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, ProviderError> {
    let mut url = Url::parse(&config.url)
        .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
    if !url.query_pairs().any(|(key, _)| key == "model") {
        url.query_pairs_mut().append_pair("model", &config.model);
    }
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
    request
        .headers_mut()
        .insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));
    if let Some(api_key) = &config.api_key {
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
        request.headers_mut().insert(AUTHORIZATION, authorization);
    }
    Ok(request)
}

#[allow(clippy::cast_possible_truncation)]
fn duration_ms(duration_us: u64) -> u16 {
    u16::try_from((duration_us / 1_000).max(1))
        .unwrap_or(u16::MAX)
        .max(1)
}

fn pcm_duration_us(audio_b64: &str) -> u64 {
    let Ok(bytes) = BASE64.decode(audio_b64) else {
        return u64::from(DEFAULT_FRAME_DURATION_MS) * 1_000;
    };
    u64::try_from(bytes.len()).unwrap_or_default() * 1_000_000 / (u64::from(SAMPLE_RATE) * 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_adds_model_and_realtime_header() {
        let request = connection_request(&OpenAiRealtimeConfig {
            url: "ws://127.0.0.1:9000/realtime".to_owned(),
            api_key: None,
            model: "local-speech".to_owned(),
            voice: "default".to_owned(),
            instructions: String::new(),
        })
        .expect("request");
        assert!(request.uri().to_string().contains("model=local-speech"));
        assert_eq!(request.headers()["OpenAI-Beta"], "realtime=v1");
    }

    #[test]
    fn pcm_duration_uses_24khz_mono_s16() {
        let audio = BASE64.encode(vec![0_u8; 960]);
        assert_eq!(pcm_duration_us(&audio), 20_000);
    }
}
