//! Conversational duplex provider with formant TTS.
//!
//! - Builds a **natural spoken reply** (never pure echo).
//! - When an [`LlmBridge`] is configured with a provider key, uses a real
//!   open model (NVIDIA NIM free tier, Ollama, Groq, …) for the reply text.
//! - Speaks with a lightweight formant synthesizer; different voice ids change
//!   pitch / timbre so switching and preview are audible offline.

use std::{f32::consts::TAU, sync::Arc, time::Duration};

use async_trait::async_trait;
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, LicenseClass, Modality,
    ModalityCapabilities, OutputTextDelta, OutputTextFinal, PcmAudioFrame, ProviderClass,
    ProviderLifecycleState, ProviderLimits, ProviderManifest, ProviderState, RealtimeEvent,
};
use tokio::{sync::mpsc, time::sleep};
use tokio_util::sync::CancellationToken;

use crate::{
    tools::{
        identity_reply, is_junk_spoken, looks_like_fact_query, looks_like_identity,
        looks_like_search, public_llm_answer, public_tool_answer, search_query_from,
        soft_no_answer, try_builtin_tools, web_search,
    },
    LlmBridge, ProviderEmission, ProviderError, ProviderInput,
    ProviderOutput, ProviderSession, ProviderSessionRequest, RealtimeProvider,
};

/// Built-in formant voice profiles (audible differences offline).
pub static VOICE_PRESETS: &[(&str, &str, f32)] = &[
    ("en_US-lessac-medium", "Lessac", 165.0),
    ("en_US-amy-medium", "Amy", 195.0),
    ("en_US-ryan-high", "Ryan", 125.0),
    ("en_US-joe-medium", "Joe", 140.0),
    ("en_US-kathleen-low", "Kathleen", 175.0),
    ("en_GB-alba-medium", "Alba", 185.0),
    ("alloy", "Alloy", 155.0),
    ("aria", "Aria", 200.0),
    ("cove", "Cove", 118.0),
    ("ember", "Ember", 150.0),
    ("juniper", "Juniper", 190.0),
    ("maple", "Maple", 160.0),
];

#[derive(Clone)]
pub struct MockDuplexProvider {
    output_sample_rate: u32,
    frame_duration_ms: u16,
    llm: Option<Arc<LlmBridge>>,
    /// Active formant voice id (updated from session config / client).
    voice_id: Arc<std::sync::RwLock<String>>,
}

impl Default for MockDuplexProvider {
    fn default() -> Self {
        Self {
            output_sample_rate: 24_000,
            frame_duration_ms: 20,
            llm: None,
            voice_id: Arc::new(std::sync::RwLock::new("en_US-lessac-medium".into())),
        }
    }
}

impl MockDuplexProvider {
    #[must_use]
    pub fn with_llm(llm: Arc<LlmBridge>) -> Self {
        Self {
            llm: Some(llm),
            ..Self::default()
        }
    }

    pub fn set_voice(&self, voice_id: &str) {
        if let Ok(mut g) = self.voice_id.write() {
            *g = voice_id.to_owned();
        }
    }

    #[must_use]
    pub fn voice(&self) -> String {
        self.voice_id
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "en_US-lessac-medium".into())
    }
}

/// Render PCM i16 LE preview for a voice (offline formant).
#[must_use]
pub fn preview_voice_pcm(voice_id: &str, text: &str, sample_rate: u32) -> Vec<u8> {
    let sample_rate = if sample_rate == 0 { 24_000 } else { sample_rate };
    let frame_ms = 20u16;
    let samples_per_frame =
        usize::try_from(u64::from(sample_rate) * u64::from(frame_ms) / 1_000).unwrap_or(480);
    let speak = if text.trim().is_empty() {
        format!("This is the {} voice.", voice_display_name(voice_id))
    } else {
        text.to_owned()
    };
    let char_count = speak.chars().count().max(8);
    let total_ms = (char_count as u64 * 70).clamp(500, 3_500);
    let frame_count = (total_ms / u64::from(frame_ms)).max(12);
    let mut synth = FormantSynth::new(sample_rate, &speak, voice_id);
    let mut pcm = Vec::new();
    for _ in 0..frame_count {
        pcm.extend(synth.next_frame(samples_per_frame));
    }
    pcm_i16_to_le_bytes(&pcm)
}

fn voice_display_name(id: &str) -> &str {
    VOICE_PRESETS
        .iter()
        .find(|(vid, _, _)| *vid == id)
        .map(|(_, name, _)| *name)
        .unwrap_or(id)
}

fn voice_f0(id: &str) -> f32 {
    VOICE_PRESETS
        .iter()
        .find(|(vid, _, _)| *vid == id)
        .map(|(_, _, f0)| *f0)
        .unwrap_or(165.0)
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
        let llm = self.llm.clone();
        let voice_id = Arc::clone(&self.voice_id);

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
                        let voice = voice_id
                            .read()
                            .map(|g| g.clone())
                            .unwrap_or_else(|_| "en_US-lessac-medium".into());
                        tokio::spawn(generate_mock_response(
                            output_sender.clone(),
                            generation_id,
                            prompt_hint,
                            sample_rate,
                            frame_duration_ms,
                            voice,
                            llm.clone(),
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
    voice_id: String,
    llm: Option<Arc<LlmBridge>>,
    cancellation: CancellationToken,
) {
    if cancellation.is_cancelled() {
        return;
    }
    // Filler-only turns: soft ack, no LLM, no long synthesis.
    if is_filler_only(&prompt) {
        let ack = "Mm-hmm.";
        let _ = send(
            &sender,
            generation_id,
            0,
            RealtimeEvent::ProviderState(ProviderState {
                state: ProviderLifecycleState::Generating,
            }),
        )
        .await;
        let _ = send(
            &sender,
            generation_id,
            0,
            RealtimeEvent::OutputTextFinal(OutputTextFinal {
                text: ack.to_owned(),
            }),
        )
        .await;
        let _ = send(
            &sender,
            generation_id,
            0,
            RealtimeEvent::ProviderState(ProviderState {
                state: ProviderLifecycleState::Complete,
            }),
        )
        .await;
        return;
    }

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

    // Ignore synthetic / empty VAD prompts (WebRTC used to invent these).
    if is_bogus_prompt(&prompt) {
        let _ = send(
            &sender,
            generation_id,
            0,
            RealtimeEvent::ProviderState(ProviderState {
                state: ProviderLifecycleState::Complete,
            }),
        )
        .await;
        return;
    }

    // Fast path: LLM reply → text only. Browser speaks with natural OS voices.
    let response = craft_spoken_reply(&prompt, llm.as_deref()).await;
    if cancellation.is_cancelled() {
        return;
    }
    if response.trim().is_empty() {
        return;
    }

    // Stream words quickly for UI (no artificial per-frame sleep).
    let words: Vec<&str> = response.split_whitespace().collect();
    for (index, word) in words.iter().enumerate() {
        if cancellation.is_cancelled() {
            return;
        }
        let prefix = if index == 0 { "" } else { " " };
        if send(
            &sender,
            generation_id,
            u64::try_from(index).unwrap_or_default() * 8_000,
            RealtimeEvent::OutputTextDelta(OutputTextDelta {
                delta: format!("{prefix}{word}"),
            }),
        )
        .await
        .is_err()
        {
            return;
        }
        // Tiny yield so cancel can land; keep under ~1ms/word effective.
        if index % 4 == 3 {
            sleep(Duration::from_millis(1)).await;
        }
    }

    if cancellation.is_cancelled() {
        return;
    }
    let _ = send(
        &sender,
        generation_id,
        0,
        RealtimeEvent::OutputTextFinal(OutputTextFinal {
            text: response.clone(),
        }),
    )
    .await;
    let _ = send(
        &sender,
        generation_id,
        0,
        RealtimeEvent::ProviderState(ProviderState {
            state: ProviderLifecycleState::Complete,
        }),
    )
    .await;

    // Optional formant only when explicitly enabled (legacy demos).
    let emit_formant = std::env::var("OPENLIVE_EMIT_FORMANT")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if emit_formant && !cancellation.is_cancelled() {
        let char_count = response.chars().count().max(8);
        let total_ms = (char_count as u64 * 40).clamp(200, 1_500);
        let frame_count = (total_ms / u64::from(frame_duration_ms)).max(4);
        let samples_per_frame =
            usize::try_from(u64::from(sample_rate) * u64::from(frame_duration_ms) / 1_000)
                .unwrap_or(480);
        let mut synth = FormantSynth::new(sample_rate, &response, &voice_id);
        for frame_index in 0..frame_count {
            if cancellation.is_cancelled() {
                return;
            }
            let pcm = synth.next_frame(samples_per_frame);
            let _ = sender
                .send(ProviderEmission {
                    generation_id: Some(generation_id),
                    media_offset_us: frame_index * u64::from(frame_duration_ms) * 1_000,
                    output: ProviderOutput::Audio(PcmAudioFrame {
                        pcm: pcm_i16_to_le_bytes(&pcm),
                        sample_rate,
                        channels: 1,
                        frame_duration_ms,
                        client_speech_probability: None,
                        client_output_level: None,
                        client_echo_probability: None,
                    }),
                })
                .await;
            sleep(Duration::from_millis(u64::from(frame_duration_ms) / 2)).await;
        }
    }
    let _ = (sample_rate, frame_duration_ms, voice_id);
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
            output: ProviderOutput::Event(event),
        })
        .await
}

/// Lightweight Klatt-inspired formant synthesizer for offline demos.
/// Not a substitute for neural TTS (use Piper / openedai-speech for that).
struct FormantSynth {
    sample_rate: f32,
    sample_index: u64,
    f0: f32,
    units: Vec<PhoneUnit>,
    unit_index: usize,
    unit_sample: u64,
    unit_samples: u64,
}

#[derive(Clone, Copy)]
struct PhoneUnit {
    f1: f32,
    f2: f32,
    f3: f32,
    voiced: bool,
    duration_ms: u32,
}

impl FormantSynth {
    fn new(sample_rate: u32, text: &str, voice_id: &str) -> Self {
        let units = text_to_phone_units(text);
        let first_dur = units.first().map_or(80, |u| u.duration_ms);
        Self {
            sample_rate: sample_rate as f32,
            sample_index: 0,
            f0: voice_f0(voice_id),
            units,
            unit_index: 0,
            unit_sample: 0,
            unit_samples: (first_dur as f32 * 0.001 * sample_rate as f32) as u64,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    fn next_frame(&mut self, sample_count: usize) -> Vec<i16> {
        let mut out = Vec::with_capacity(sample_count);
        for _ in 0..sample_count {
            if self.unit_index >= self.units.len() {
                // Soft trailing breath.
                out.push(0);
                self.sample_index += 1;
                continue;
            }
            let unit = self.units[self.unit_index];
            if self.unit_sample >= self.unit_samples {
                self.unit_index += 1;
                self.unit_sample = 0;
                if self.unit_index < self.units.len() {
                    let next = self.units[self.unit_index];
                    self.unit_samples =
                        (next.duration_ms as f32 * 0.001 * self.sample_rate) as u64;
                }
                out.push(0);
                self.sample_index += 1;
                continue;
            }

            let t = self.sample_index as f32 / self.sample_rate;
            // Mild F0 contour (statement fall).
            let progress = self.unit_index as f32 / self.units.len().max(1) as f32;
            let f0 = self.f0 * (1.05 - 0.12 * progress)
                + 4.0 * (t * 3.1).sin()
                + 2.0 * (t * 7.7).sin();

            let sample = if unit.voiced {
                let excitation = buzz(t, f0);
                let s = formant(excitation, t, unit.f1, 60.0)
                    + 0.55 * formant(excitation, t, unit.f2, 90.0)
                    + 0.30 * formant(excitation, t, unit.f3, 120.0);
                // Soft attack/release within phone.
                let edge = self
                    .unit_sample
                    .min(self.unit_samples.saturating_sub(self.unit_sample + 1));
                let env = (edge as f32 / (0.012 * self.sample_rate)).min(1.0);
                s * env * 0.22
            } else {
                // Unvoiced frication / silence.
                let noise = pseudo_noise(self.sample_index) * 0.08;
                formant(noise, t, unit.f2, 200.0) * 0.12
            };

            let clipped = sample.clamp(-1.0, 1.0);
            out.push((clipped * 12_000.0) as i16);
            self.sample_index += 1;
            self.unit_sample += 1;
        }
        out
    }
}

fn buzz(t: f32, f0: f32) -> f32 {
    let phase = (t * f0).fract();
    // Soft saw / glottal pulse approximation.
    2.0 * (0.5 - phase) + 0.25 * (phase * TAU * 2.0).sin()
}

fn formant(excitation: f32, t: f32, freq: f32, bandwidth: f32) -> f32 {
    // Cheap resonating band-pass: excitation * damped oscillator envelope proxy.
    let decay = (-bandwidth * 0.002).exp();
    let osc = (t * freq * TAU).sin();
    excitation * osc * (0.55 + 0.45 * decay)
}

fn pseudo_noise(index: u64) -> f32 {
    // Deterministic LCG noise for stable tests.
    let x = index.wrapping_mul(1_103_515_245).wrapping_add(12_345);
    let v = (x >> 16) as u16;
    (f32::from(v) / 32_768.0) - 1.0
}

fn text_to_phone_units(text: &str) -> Vec<PhoneUnit> {
    let mut units = Vec::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            units.push(PhoneUnit {
                f1: 500.0,
                f2: 1500.0,
                f3: 2500.0,
                voiced: false,
                duration_ms: 50,
            });
            continue;
        }
        if !ch.is_ascii_alphabetic() {
            units.push(PhoneUnit {
                f1: 400.0,
                f2: 1200.0,
                f3: 2400.0,
                voiced: false,
                duration_ms: 40,
            });
            continue;
        }
        let c = ch.to_ascii_lowercase();
        let (f1, f2, f3, voiced, duration_ms) = match c {
            'a' | 'A' => (800.0, 1200.0, 2500.0, true, 95),
            'e' => (500.0, 1800.0, 2500.0, true, 85),
            'i' => (300.0, 2300.0, 3000.0, true, 80),
            'o' => (500.0, 900.0, 2400.0, true, 95),
            'u' => (350.0, 800.0, 2200.0, true, 90),
            'y' => (350.0, 2100.0, 2800.0, true, 75),
            'm' | 'n' => (300.0, 1200.0, 2200.0, true, 70),
            'l' | 'r' => (400.0, 1400.0, 2500.0, true, 65),
            'w' => (350.0, 700.0, 2200.0, true, 70),
            's' | 'f' | 'h' | 'x' | 'z' => (500.0, 4000.0, 5000.0, false, 55),
            'p' | 't' | 'k' | 'b' | 'd' | 'g' => (400.0, 1500.0, 2500.0, false, 45),
            _ => (500.0, 1500.0, 2500.0, true, 70),
        };
        units.push(PhoneUnit {
            f1,
            f2,
            f3,
            voiced,
            duration_ms,
        });
    }
    if units.is_empty() {
        units.push(PhoneUnit {
            f1: 500.0,
            f2: 1500.0,
            f3: 2500.0,
            voiced: true,
            duration_ms: 200,
        });
    }
    units
}

fn pcm_i16_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

fn is_filler_only(prompt: &str) -> bool {
    let t = prompt
        .trim()
        .to_ascii_lowercase()
        .trim_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace())
        .to_owned();
    if t.is_empty() {
        return true;
    }
    let stripped: String = t
        .split_whitespace()
        .filter(|w| {
            !matches!(
                *w,
                "um" | "uh"
                    | "uhm"
                    | "erm"
                    | "er"
                    | "ah"
                    | "eh"
                    | "hmm"
                    | "hm"
                    | "mm"
                    | "mmm"
                    | "mhm"
                    | "mhmm"
                    | "uh-huh"
                    | "like"
                    | "so"
                    | "yeah"
                    | "yep"
                    | "okay"
                    | "ok"
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    stripped.len() < 2
}

fn is_bogus_prompt(prompt: &str) -> bool {
    let t = prompt.trim().to_ascii_lowercase();
    t.is_empty()
        || t.contains("openlive detected a completed speech turn")
        || t == "openlive detected a completed speech turn."
}

/// Tools first (search/math/time), then LLM. Never invent "got it you said…" stubs.
async fn craft_spoken_reply(prompt: &str, llm: Option<&LlmBridge>) -> String {
    let user = prompt.trim();
    if user.is_empty() || is_filler_only(user) || is_bogus_prompt(user) {
        return "Mm-hmm.".to_owned();
    }

    // "你是谁" / who are you — answer as OpenLive, never Wikipedia.
    if looks_like_identity(user) {
        return identity_reply(user);
    }

    // Built-in tools only for explicit math / time / search intents.
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .ok();
    if let Some(client) = http.as_ref() {
        if looks_like_search(user) || looks_like_fact_query(user) || user.chars().any(|c| c.is_ascii_digit())
        {
            if let Some((raw, _tools)) = try_builtin_tools(client, user).await {
                return sanitize_spoken(&public_tool_answer(user, &raw));
            }
            if looks_like_search(user) {
                let q = search_query_from(user);
                if q.len() >= 2 {
                    match web_search(client, &q).await {
                        Ok(raw) => return sanitize_spoken(&public_tool_answer(user, &raw)),
                        Err(_) => {
                            return format!(
                                "I couldn't find solid results for '{q}'. Try a shorter name."
                            );
                        }
                    }
                }
            }
        }
    }

    if let Some(bridge) = llm {
        if bridge.settings().can_chat() {
            match bridge.chat_voice(user).await {
                Ok(text) => {
                    if let Some(safe) = public_llm_answer(&text) {
                        let cleaned = sanitize_spoken(&safe);
                        // Reject false "I can't search" claims — we just tried tools.
                        let low = cleaned.to_ascii_lowercase();
                        let false_cant = low.contains("can't search")
                            || low.contains("cannot search")
                            || low.contains("don't have access to the internet")
                            || low.contains("unable to browse")
                            || low.contains("as a language model");
                        if !cleaned.is_empty() && !is_junk_spoken(&cleaned) && !false_cant {
                            return cleaned;
                        }
                    }
                    return soft_no_answer();
                }
                Err(_) => {
                    return "I couldn't reach the language model. Check your API key and model in Settings.".to_owned();
                }
            }
        }
    }

    "I'm listening, but no language model is connected. Open Settings, choose a provider, paste an API key, and pick a model.".to_owned()
}

fn sanitize_spoken(text: &str) -> String {
    let mut t = text
        .replace("**", "")
        .replace("##", "")
        .replace('`', "")
        .replace('*', "")
        .replace('_', " ");
    // Keep Latin + CJK + common punctuation (Chinese replies must not be stripped).
    t = t
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || c.is_ascii_whitespace()
                || c.is_alphanumeric() // includes CJK letters
                || matches!(
                    *c,
                    '.' | ','
                        | '!'
                        | '?'
                        | '\''
                        | '-'
                        | ':'
                        | ';'
                        | '%'
                        | '('
                        | ')'
                        | '。'
                        | '，'
                        | '、'
                        | '！'
                        | '？'
                        | '：'
                        | '；'
                        | '「'
                        | '」'
                        | '『'
                        | '』'
                        | '（'
                        | '）'
                        | '…'
                        | '—'
                        | '·'
                )
        })
        .collect();
    // Don't collapse CJK with split_whitespace-only (no spaces between chars).
    if t.chars().any(|c| !c.is_ascii()) {
        t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    } else {
        t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    // Drop leading planning crumbs if any slipped through.
    for lead in [
        "Got it ",
        "Got it. ",
        "Okay so ",
        "Ok so ",
        "Alright ",
        "Sure, ",
        "Sure ",
    ] {
        if let Some(rest) = t.strip_prefix(lead) {
            // Only strip when the rest still looks like planning.
            if is_junk_spoken(rest) || rest.to_ascii_lowercase().starts_with("let") {
                t = rest.to_owned();
            }
            break;
        }
    }
    // Keep short for speech latency.
    if t.len() > 300 {
        t = t.chars().take(280).collect::<String>();
        if let Some(i) = t.rfind(['.', '!', '?']) {
            t = t[..=i].to_owned();
        } else {
            t.push('…');
        }
    }
    t.trim().to_owned()
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
    fn formant_frame_has_expected_length_and_energy() {
        let mut synth = FormantSynth::new(24_000, "hello", "en_US-lessac-medium");
        let frame = synth.next_frame(480);
        assert_eq!(frame.len(), 480);
        let energy: i64 = frame.iter().map(|s| i64::from(*s).abs()).sum();
        assert!(energy > 0, "formant frame should not be silent");
    }

    #[test]
    fn text_to_phone_units_covers_letters() {
        let units = text_to_phone_units("hi");
        assert!(units.len() >= 2);
    }
}
