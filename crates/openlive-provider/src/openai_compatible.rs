use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::StreamExt;
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, ErrorEvent, LicenseClass, Modality,
    ModalityCapabilities, OutputAudioFrame, OutputTextDelta, OutputTextFinal, ProviderClass,
    ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent, TaskCreated, TaskResult,
};
use reqwest::{multipart, Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
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
        self.stream_answer(&sender, generation_id, task_id, transcript, &cancellation)
            .await;
    }

    async fn stream_answer(
        &self,
        sender: &mpsc::Sender<ProviderEmission>,
        generation_id: Uuid,
        task_id: Uuid,
        transcript: String,
        cancellation: &CancellationToken,
    ) {
        let (completion_sender, mut completion_receiver) = mpsc::channel(64);
        let (speech_sender, speech_receiver) = mpsc::channel(8);
        let completion_provider = self.clone();
        let completion_cancellation = cancellation.clone();
        tokio::spawn(async move {
            completion_provider
                .stream_completion(transcript, completion_sender, completion_cancellation)
                .await;
        });
        let speech_provider = self.clone();
        let speech_output = sender.clone();
        let speech_cancellation = cancellation.clone();
        let speech_worker = tokio::spawn(async move {
            speech_provider
                .run_speech_worker(
                    speech_receiver,
                    speech_output,
                    generation_id,
                    speech_cancellation,
                )
                .await
        });

        let mut answer = String::new();
        let mut segmenter = SpeechSegmenter::default();
        while let Some(event) = completion_receiver.recv().await {
            match event {
                CompletionEvent::Delta(delta) => {
                    answer.push_str(&delta);
                    if send(
                        sender,
                        Some(generation_id),
                        0,
                        RealtimeEvent::OutputTextDelta(OutputTextDelta {
                            delta: delta.clone(),
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    for segment in segmenter.push(&delta) {
                        if speech_sender.send(segment).await.is_err() {
                            return;
                        }
                    }
                }
                CompletionEvent::Complete => break,
                CompletionEvent::Error(error) => {
                    send_pipeline_error(sender, generation_id, "cognition_failed", error).await;
                    return;
                }
            }
        }
        if let Some(segment) = segmenter.finish() {
            if speech_sender.send(segment).await.is_err() {
                return;
            }
        }
        drop(speech_sender);
        finish_streamed_answer(sender, generation_id, task_id, answer, speech_worker).await;
    }

    async fn stream_completion(
        &self,
        transcript: String,
        sender: mpsc::Sender<CompletionEvent>,
        cancellation: CancellationToken,
    ) {
        let request = ChatRequest {
            model: &self.config.llm_model,
            messages: [
                ChatMessage {
                    role: "system",
                    content: &self.config.system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: &transcript,
                },
            ],
            stream: true,
        };
        let builder = self.authorize(
            self.client
                .post(self.endpoint("chat/completions"))
                .json(&request),
        );
        let response = match send_cancelable(builder, &cancellation).await {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(CompletionEvent::Error(error)).await;
                return;
            }
        };
        if !response.status().is_success() {
            let error = checked_response(response)
                .await
                .err()
                .unwrap_or_else(|| "completion endpoint failed".to_owned());
            let _ = sender.send(CompletionEvent::Error(error)).await;
            return;
        }
        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));
        if is_event_stream {
            stream_sse(response, &sender, &cancellation).await;
        } else {
            stream_json_completion(response, &sender).await;
        }
    }

    async fn run_speech_worker(
        &self,
        mut receiver: mpsc::Receiver<String>,
        sender: mpsc::Sender<ProviderEmission>,
        generation_id: Uuid,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        let mut output_offset_us = 0_u64;
        let mut announced = false;
        while let Some(segment) = receiver.recv().await {
            if cancellation.is_cancelled() {
                return Ok(());
            }
            if !announced {
                send_state(&sender, generation_id, "synthesizing")
                    .await
                    .map_err(|error| error.to_string())?;
                announced = true;
            }
            self.stream_speech_segment(
                &segment,
                &sender,
                generation_id,
                &mut output_offset_us,
                &cancellation,
            )
            .await?;
        }
        Ok(())
    }

    async fn stream_speech_segment(
        &self,
        text: &str,
        sender: &mpsc::Sender<ProviderEmission>,
        generation_id: Uuid,
        output_offset_us: &mut u64,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
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
        if !response.status().is_success() {
            return Err(checked_response(response)
                .await
                .err()
                .unwrap_or_else(|| "speech endpoint failed".to_owned()));
        }
        let mut stream = response.bytes_stream();
        let mut framer = PcmFramer::default();
        loop {
            let item = tokio::select! {
                () = cancellation.cancelled() => return Ok(()),
                item = stream.next() => item,
            };
            let Some(item) = item else {
                break;
            };
            let chunk = item.map_err(|error| error.to_string())?;
            for frame in framer.push(&chunk) {
                emit_pcm_frame(sender, generation_id, *output_offset_us, frame).await?;
                *output_offset_us =
                    (*output_offset_us).saturating_add(u64::from(FRAME_DURATION_MS) * 1_000);
            }
        }
        if let Some(frame) = framer.finish() {
            emit_pcm_frame(sender, generation_id, *output_offset_us, frame).await?;
            *output_offset_us =
                (*output_offset_us).saturating_add(u64::from(FRAME_DURATION_MS) * 1_000);
        }
        Ok(())
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

#[derive(Debug)]
enum CompletionEvent {
    Delta(String),
    Complete,
    Error(String),
}

async fn finish_streamed_answer(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Uuid,
    task_id: Uuid,
    answer: String,
    speech_worker: tokio::task::JoinHandle<Result<(), String>>,
) {
    if answer.trim().is_empty() {
        send_pipeline_error(
            sender,
            generation_id,
            "cognition_failed",
            "completion returned no text".to_owned(),
        )
        .await;
        return;
    }
    let _ = send(
        sender,
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
    let _ = send(
        sender,
        Some(generation_id),
        0,
        RealtimeEvent::OutputTextFinal(OutputTextFinal { text: answer }),
    )
    .await;

    match speech_worker.await {
        Ok(Ok(())) => {
            let _ = send_state(sender, generation_id, "complete").await;
        }
        Ok(Err(error)) => {
            send_pipeline_error(sender, generation_id, "synthesis_failed", error).await;
        }
        Err(error) => {
            send_pipeline_error(sender, generation_id, "synthesis_failed", error.to_string()).await;
        }
    }
}

async fn stream_sse(
    response: Response,
    sender: &mpsc::Sender<CompletionEvent>,
    cancellation: &CancellationToken,
) {
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    loop {
        let item = tokio::select! {
            () = cancellation.cancelled() => return,
            item = stream.next() => item,
        };
        let Some(item) = item else {
            let _ = sender.send(CompletionEvent::Complete).await;
            return;
        };
        let chunk = match item {
            Ok(chunk) => chunk,
            Err(error) => {
                let _ = sender.send(CompletionEvent::Error(error.to_string())).await;
                return;
            }
        };
        pending.extend_from_slice(&chunk);
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=newline).collect();
            match parse_sse_line(&line) {
                Ok(Some(CompletionEvent::Complete)) => {
                    let _ = sender.send(CompletionEvent::Complete).await;
                    return;
                }
                Ok(Some(event)) => {
                    if sender.send(event).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = sender.send(CompletionEvent::Error(error)).await;
                    return;
                }
            }
        }
    }
}

async fn stream_json_completion(response: Response, sender: &mpsc::Sender<CompletionEvent>) {
    let payload = match checked_response(response).await {
        Ok(payload) => payload,
        Err(error) => {
            let _ = sender.send(CompletionEvent::Error(error)).await;
            return;
        }
    };
    let completion: ChatResponse = match serde_json::from_slice(&payload) {
        Ok(completion) => completion,
        Err(error) => {
            let _ = sender.send(CompletionEvent::Error(error.to_string())).await;
            return;
        }
    };
    let Some(content) = completion
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
    else {
        let _ = sender
            .send(CompletionEvent::Error(
                "completion returned no choices".to_owned(),
            ))
            .await;
        return;
    };
    let _ = sender.send(CompletionEvent::Delta(content)).await;
    let _ = sender.send(CompletionEvent::Complete).await;
}

fn parse_sse_line(line: &[u8]) -> Result<Option<CompletionEvent>, String> {
    let line = String::from_utf8_lossy(line);
    let trimmed = line.trim();
    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok(None);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(Some(CompletionEvent::Complete));
    }
    let value: Value = serde_json::from_str(data).map_err(|error| error.to_string())?;
    let delta = value
        .pointer("/choices/0/delta/content")
        .or_else(|| value.pointer("/choices/0/text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if delta.is_empty() {
        Ok(None)
    } else {
        Ok(Some(CompletionEvent::Delta(delta.to_owned())))
    }
}

#[derive(Default)]
struct SpeechSegmenter {
    buffer: String,
}

impl SpeechSegmenter {
    fn push(&mut self, delta: &str) -> Vec<String> {
        self.buffer.push_str(delta);
        let mut segments = Vec::new();
        while let Some(end) = self.next_boundary() {
            let segment: String = self.buffer.drain(..end).collect();
            let segment = segment.trim().to_owned();
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
        segments
    }

    fn finish(&mut self) -> Option<String> {
        let remaining = std::mem::take(&mut self.buffer);
        let remaining = remaining.trim();
        (!remaining.is_empty()).then(|| remaining.to_owned())
    }

    fn next_boundary(&self) -> Option<usize> {
        let mut character_count = 0_usize;
        let mut fallback = None;
        for (index, character) in self.buffer.char_indices() {
            character_count = character_count.saturating_add(1);
            let end = index + character.len_utf8();
            if character_count >= 18 && matches!(character, '.' | '!' | '?' | ';' | ':' | '\n') {
                return Some(end);
            }
            if character_count >= 40 && character.is_whitespace() {
                fallback = Some(end);
            }
            if character_count >= 72 {
                return fallback.or(Some(end));
            }
        }
        None
    }
}

#[derive(Default)]
struct PcmFramer {
    buffer: Vec<u8>,
}

impl PcmFramer {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(chunk);
        let frame_size = pcm_frame_size();
        let mut frames = Vec::new();
        while self.buffer.len() >= frame_size {
            let remainder = self.buffer.split_off(frame_size);
            frames.push(std::mem::replace(&mut self.buffer, remainder));
        }
        frames
    }

    fn finish(mut self) -> Option<Vec<u8>> {
        if self.buffer.is_empty() {
            return None;
        }
        self.buffer.resize(pcm_frame_size(), 0);
        Some(self.buffer)
    }
}

fn pcm_frame_size() -> usize {
    usize::try_from(OUTPUT_SAMPLE_RATE).unwrap_or_default() * 2 * usize::from(FRAME_DURATION_MS)
        / 1_000
}

async fn emit_pcm_frame(
    sender: &mpsc::Sender<ProviderEmission>,
    generation_id: Uuid,
    media_offset_us: u64,
    frame: Vec<u8>,
) -> Result<(), String> {
    send(
        sender,
        Some(generation_id),
        media_offset_us,
        RealtimeEvent::OutputAudioFrame(OutputAudioFrame {
            audio_b64: BASE64.encode(frame),
            sample_rate: OUTPUT_SAMPLE_RATE,
            channels: 1,
            frame_duration_ms: FRAME_DURATION_MS,
        }),
    )
    .await
    .map_err(|error| error.to_string())
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
    stream: bool,
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

    #[test]
    fn speech_segmenter_emits_early_complete_clause() {
        let mut segmenter = SpeechSegmenter::default();
        assert!(segmenter.push("This is a natural opening").is_empty());
        let segments = segmenter.push(" sentence. The next thought");
        assert_eq!(segments, vec!["This is a natural opening sentence."]);
        assert_eq!(segmenter.finish().as_deref(), Some("The next thought"));
    }

    #[test]
    fn pcm_framer_preserves_and_pads_stream_bytes() {
        let mut packetizer = PcmFramer::default();
        let output_frames = packetizer.push(&vec![1_u8; pcm_frame_size() + 100]);
        assert_eq!(output_frames.len(), 1);
        assert_eq!(output_frames[0].len(), pcm_frame_size());
        let final_frame = packetizer.finish().expect("final frame");
        assert_eq!(final_frame.len(), pcm_frame_size());
        assert!(final_frame[..100].iter().all(|byte| *byte == 1));
        assert!(final_frame[100..].iter().all(|byte| *byte == 0));
    }
}
