use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, ErrorEvent, LicenseClass, Modality,
    ModalityCapabilities, OutputAudioFrame, OutputTextDelta, OutputTextFinal, ProviderClass,
    ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent, TaskCreated, TaskResult,
};
use reqwest::{multipart, Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{sync::mpsc, time::sleep};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ProviderEmission, ProviderError, ProviderInput, ProviderSession, ProviderSessionRequest,
    RealtimeProvider,
};

const INPUT_SAMPLE_RATE: u32 = 16_000;
const OUTPUT_SAMPLE_RATE: u32 = 24_000;
const FRAME_DURATION_MS: u16 = 20;
const MAX_CAPTURE_SECONDS: usize = 60;

#[derive(Debug, Clone)]
pub struct OpenAiCompatibleConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub asr_model: String,
    pub llm_model: String,
    pub tts_model: String,
    pub voice: String,
    pub system_prompt: String,
}

impl Default for OpenAiCompatibleConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8000/v1".to_owned(),
            api_key: None,
            asr_model: "whisper-1".to_owned(),
            llm_model: "default".to_owned(),
            tts_model: "tts-1".to_owned(),
            voice: "alloy".to_owned(),
            system_prompt: "Respond naturally and concisely in spoken language.".to_owned(),
        }
    }
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    config: OpenAiCompatibleConfig,
    client: Client,
}

impl OpenAiCompatibleProvider {
    /// Creates a provider for OpenAI-compatible ASR, chat, and PCM TTS endpoints.
    ///
    /// # Errors
    ///
    /// Returns an error when the base URL is empty or the HTTP client cannot
    /// be configured.
    pub fn new(config: OpenAiCompatibleConfig) -> Result<Self, ProviderError> {
        if config.base_url.trim().is_empty() {
            return Err(ProviderError::InvalidConfiguration(
                "base_url cannot be empty".to_owned(),
            ));
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
        Ok(Self { config, client })
    }
}

#[async_trait]
impl RealtimeProvider for OpenAiCompatibleProvider {
    fn manifest(&self) -> ProviderManifest {
        ProviderManifest {
            id: format!("openai-compatible/{}", self.config.llm_model),
            adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_class: ProviderClass::Cascade,
            license_class: LicenseClass::Unknown,
            modalities: ModalityCapabilities {
                input: vec![Modality::Audio, Modality::Text],
                output: vec![Modality::Audio, Modality::Text, Modality::State],
            },
            duplex: DuplexCapabilities {
                continuous_input_while_output: true,
                native_turn_policy: false,
                native_barge_in: false,
                state_tokens: false,
            },
            audio: AudioCapabilities {
                input_sample_rates: vec![INPUT_SAMPLE_RATE],
                output_sample_rates: vec![OUTPUT_SAMPLE_RATE],
                frame_ms: FRAME_DURATION_MS,
            },
            control: ControlCapabilities {
                text_injection: true,
                context_update: true,
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
        let provider = self.clone();

        tokio::spawn(async move {
            let mut audio = Vec::new();
            let mut active: Option<(Uuid, CancellationToken)> = None;
            while let Some(input) = input_receiver.recv().await {
                match input {
                    ProviderInput::AudioFrame { frame, .. } => {
                        append_audio(&mut audio, &frame);
                    }
                    ProviderInput::CommitResponse {
                        generation_id,
                        prompt_hint,
                        ..
                    } => {
                        cancel_active(&mut active);
                        let captured_audio = std::mem::take(&mut audio);
                        let cancellation = CancellationToken::new();
                        active = Some((generation_id, cancellation.clone()));
                        tokio::spawn(provider.clone().run_pipeline(
                            output_sender.clone(),
                            generation_id,
                            captured_audio,
                            prompt_hint,
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

impl OpenAiCompatibleProvider {
    #[allow(clippy::too_many_lines)]
    async fn run_pipeline(
        self,
        sender: mpsc::Sender<ProviderEmission>,
        generation_id: Uuid,
        audio: Vec<u8>,
        prompt_hint: String,
        cancellation: CancellationToken,
    ) {
        let transcript = if audio.is_empty() {
            prompt_hint
        } else {
            if send_state(&sender, generation_id, "transcribing")
                .await
                .is_err()
            {
                return;
            }
            match self.transcribe(audio, &cancellation).await {
                Ok(transcript) => transcript,
                Err(error) => {
                    send_pipeline_error(&sender, generation_id, "transcription_failed", error)
                        .await;
                    return;
                }
            }
        };
        if cancellation.is_cancelled() {
            return;
        }

        let task_id = Uuid::new_v4();
        let _ = send(
            &sender,
            Some(generation_id),
            0,
            RealtimeEvent::TaskCreated(TaskCreated {
                task_id,
                kind: "cognition".to_owned(),
                conversation_version: 0,
            }),
        )
        .await;
        if send_state(&sender, generation_id, "reasoning")
            .await
            .is_err()
        {
            return;
        }
        let answer = match self.complete(&transcript, &cancellation).await {
            Ok(answer) => answer,
            Err(error) => {
                send_pipeline_error(&sender, generation_id, "cognition_failed", error).await;
                return;
            }
        };
        if cancellation.is_cancelled() {
            return;
        }
        let _ = send(
            &sender,
            Some(generation_id),
            0,
            RealtimeEvent::TaskResult(TaskResult {
                task_id,
                conversation_version: 0,
                content: json!({ "text": answer.clone() }),
                confidence: 1.0,
            }),
        )
        .await;

        for (index, word) in answer.split_whitespace().enumerate() {
            let prefix = if index == 0 { "" } else { " " };
            let offset = u64::try_from(index).unwrap_or_default() * 30_000;
            if send(
                &sender,
                Some(generation_id),
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

        if send_state(&sender, generation_id, "synthesizing")
            .await
            .is_err()
        {
            return;
        }
        let pcm = match self.synthesize(&answer, &cancellation).await {
            Ok(pcm) => pcm,
            Err(error) => {
                send_pipeline_error(&sender, generation_id, "synthesis_failed", error).await;
                return;
            }
        };
        if cancellation.is_cancelled() {
            return;
        }

        let bytes_per_frame = usize::try_from(OUTPUT_SAMPLE_RATE).unwrap_or_default()
            * 2
            * usize::from(FRAME_DURATION_MS)
            / 1_000;
        for (index, chunk) in pcm.chunks(bytes_per_frame).enumerate() {
            if cancellation.is_cancelled() {
                return;
            }
            let offset =
                u64::try_from(index).unwrap_or_default() * u64::from(FRAME_DURATION_MS) * 1_000;
            let mut frame = vec![0_u8; bytes_per_frame];
            frame[..chunk.len()].copy_from_slice(chunk);
            if send(
                &sender,
                Some(generation_id),
                offset,
                RealtimeEvent::OutputAudioFrame(OutputAudioFrame {
                    audio_b64: BASE64.encode(frame),
                    sample_rate: OUTPUT_SAMPLE_RATE,
                    channels: 1,
                    frame_duration_ms: FRAME_DURATION_MS,
                }),
            )
            .await
            .is_err()
            {
                return;
            }
            sleep(Duration::from_millis(u64::from(FRAME_DURATION_MS))).await;
        }

        let final_offset = u64::try_from(pcm.len() / bytes_per_frame).unwrap_or_default()
            * u64::from(FRAME_DURATION_MS)
            * 1_000;
        let _ = send(
            &sender,
            Some(generation_id),
            final_offset,
            RealtimeEvent::OutputTextFinal(OutputTextFinal { text: answer }),
        )
        .await;
        let _ = send_state(&sender, generation_id, "complete").await;
    }

    async fn transcribe(
        &self,
        pcm: Vec<u8>,
        cancellation: &CancellationToken,
    ) -> Result<String, String> {
        let wav = pcm_to_wav(&pcm, INPUT_SAMPLE_RATE)?;
        let file = multipart::Part::bytes(wav)
            .file_name("input.wav")
            .mime_str("audio/wav")
            .map_err(|error| error.to_string())?;
        let form = multipart::Form::new()
            .part("file", file)
            .text("model", self.config.asr_model.clone());
        let request = self.authorize(
            self.client
                .post(self.endpoint("audio/transcriptions"))
                .multipart(form),
        );
        let response = send_cancelable(request, cancellation).await?;
        let payload = checked_response(response).await?;
        let transcription: TranscriptionResponse =
            serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
        Ok(transcription.text)
    }

    async fn complete(
        &self,
        transcript: &str,
        cancellation: &CancellationToken,
    ) -> Result<String, String> {
        let request = ChatRequest {
            model: &self.config.llm_model,
            messages: [
                ChatMessage {
                    role: "system",
                    content: &self.config.system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: transcript,
                },
            ],
        };
        let builder = self.authorize(
            self.client
                .post(self.endpoint("chat/completions"))
                .json(&request),
        );
        let response = send_cancelable(builder, cancellation).await?;
        let payload = checked_response(response).await?;
        let completion: ChatResponse =
            serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
        completion
            .choices
            .into_iter()
            .next()
            .map(|choice| choice.message.content)
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| "completion returned no text".to_owned())
    }

    async fn synthesize(
        &self,
        text: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, String> {
        let request = SpeechRequest {
            model: &self.config.tts_model,
            voice: &self.config.voice,
            input: text,
            response_format: "pcm",
        };
        let builder = self.authorize(
            self.client
                .post(self.endpoint("audio/speech"))
                .json(&request),
        );
        let response = send_cancelable(builder, cancellation).await?;
        checked_response(response).await
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.config.base_url.trim_end_matches('/'), path)
    }

    fn authorize(&self, builder: RequestBuilder) -> RequestBuilder {
        if let Some(api_key) = &self.config.api_key {
            builder.bearer_auth(api_key)
        } else {
            builder
        }
    }
}

fn append_audio(audio: &mut Vec<u8>, frame: &openlive_protocol::InputAudioFrame) {
    if frame.channels != 1 || frame.sample_rate != INPUT_SAMPLE_RATE {
        return;
    }
    let Ok(bytes) = BASE64.decode(&frame.audio_b64) else {
        return;
    };
    audio.extend_from_slice(&bytes);
    let maximum = usize::try_from(INPUT_SAMPLE_RATE).unwrap_or_default() * 2 * MAX_CAPTURE_SECONDS;
    if audio.len() > maximum {
        let overflow = audio.len() - maximum;
        audio.drain(..overflow);
    }
}

fn cancel_active(active: &mut Option<(Uuid, CancellationToken)>) {
    if let Some((_, cancellation)) = active.take() {
        cancellation.cancel();
    }
}

async fn send_cancelable(
    request: RequestBuilder,
    cancellation: &CancellationToken,
) -> Result<Response, String> {
    tokio::select! {
        () = cancellation.cancelled() => Err("generation canceled".to_owned()),
        response = request.send() => response.map_err(|error| error.to_string()),
    }
}

async fn checked_response(response: Response) -> Result<Vec<u8>, String> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if status.is_success() {
        return Ok(bytes.to_vec());
    }
    let body = String::from_utf8_lossy(&bytes);
    Err(format!(
        "endpoint returned {status}: {}",
        body.chars().take(500).collect::<String>()
    ))
}

async fn send_state(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Uuid,
    state: &str,
) -> Result<(), mpsc::error::SendError<ProviderEmission>> {
    send(
        sender,
        Some(generation_id),
        0,
        RealtimeEvent::ProviderState(ProviderState {
            state: state.to_owned(),
        }),
    )
    .await
}

async fn send_pipeline_error(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Uuid,
    code: &str,
    message: String,
) {
    let _ = send(
        sender,
        Some(generation_id),
        0,
        RealtimeEvent::Error(ErrorEvent {
            code: code.to_owned(),
            message,
            recoverable: true,
        }),
    )
    .await;
}

async fn send(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Option<Uuid>,
    media_offset_us: u64,
    event: RealtimeEvent,
) -> Result<(), mpsc::error::SendError<ProviderEmission>> {
    sender
        .send(ProviderEmission {
            generation_id,
            media_offset_us,
            event,
        })
        .await
}

fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Result<Vec<u8>, String> {
    let data_length =
        u32::try_from(pcm.len()).map_err(|_| "captured audio is too large".to_owned())?;
    let riff_length = data_length
        .checked_add(36)
        .ok_or_else(|| "WAV length overflow".to_owned())?;
    let byte_rate = sample_rate
        .checked_mul(2)
        .ok_or_else(|| "WAV byte rate overflow".to_owned())?;
    let capacity = usize::try_from(data_length)
        .unwrap_or_default()
        .saturating_add(44);
    let mut wav = Vec::with_capacity(capacity);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_length.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_length.to_le_bytes());
    wav.extend_from_slice(pcm);
    Ok(wav)
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
}

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Serialize)]
struct SpeechRequest<'a> {
    model: &'a str,
    voice: &'a str,
    input: &'a str,
    response_format: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_has_expected_header_and_size() {
        let pcm = vec![0_u8; 640];
        let wav = pcm_to_wav(&pcm, 16_000).expect("wav");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 684);
    }

    #[test]
    fn capture_is_bounded() {
        let maximum =
            usize::try_from(INPUT_SAMPLE_RATE).unwrap_or_default() * 2 * MAX_CAPTURE_SECONDS;
        let mut audio = vec![0_u8; maximum];
        let frame = openlive_protocol::InputAudioFrame {
            audio_b64: BASE64.encode(vec![1_u8; 640]),
            sample_rate: INPUT_SAMPLE_RATE,
            channels: 1,
            frame_duration_ms: FRAME_DURATION_MS,
            client_speech_probability: None,
        };
        append_audio(&mut audio, &frame);
        assert_eq!(audio.len(), maximum);
    }
}
