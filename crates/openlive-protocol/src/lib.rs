use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: &str = "0.1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventEnvelope {
    pub protocol_version: String,
    pub event_id: Uuid,
    pub session_id: Uuid,
    pub stream_id: String,
    pub sequence: u64,
    pub media_time_us: u64,
    pub generation_id: Option<Uuid>,
    pub parent_event_id: Option<Uuid>,
    #[serde(flatten)]
    pub event: RealtimeEvent,
}

impl EventEnvelope {
    pub fn new(
        session_id: Uuid,
        stream_id: impl Into<String>,
        sequence: u64,
        media_time_us: u64,
        event: RealtimeEvent,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            event_id: Uuid::new_v4(),
            session_id,
            stream_id: stream_id.into(),
            sequence,
            media_time_us,
            generation_id: None,
            parent_event_id: None,
            event,
        }
    }

    pub fn new_with_id(
        event_id: Uuid,
        session_id: Uuid,
        stream_id: impl Into<String>,
        sequence: u64,
        media_time_us: u64,
        event: RealtimeEvent,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            event_id,
            session_id,
            stream_id: stream_id.into(),
            sequence,
            media_time_us,
            generation_id: None,
            parent_event_id: None,
            event,
        }
    }

    #[must_use]
    pub fn with_generation(mut self, generation_id: Uuid) -> Self {
        self.generation_id = Some(generation_id);
        self
    }

    #[must_use]
    pub fn with_parent(mut self, parent_event_id: Uuid) -> Self {
        self.parent_event_id = Some(parent_event_id);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum RealtimeEvent {
    SessionCreated(SessionCreated),
    SessionConfigured(SessionConfigured),
    InputAudioFrame(InputAudioFrame),
    InputAudioGap(InputAudioGap),
    Observation(Observation),
    InteractionDecision(InteractionDecision),
    ResponseRequested(ResponseRequested),
    OutputTextDelta(OutputTextDelta),
    OutputTextFinal(OutputTextFinal),
    OutputAudioFrame(OutputAudioFrame),
    OutputAudioCancel(OutputAudioCancel),
    OutputAudioPlayed(OutputAudioPlayed),
    ProviderState(ProviderState),
    TaskCreated(TaskCreated),
    TaskResult(TaskResult),
    Error(ErrorEvent),
    Ping,
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionCreated {
    pub model: String,
    pub provider_class: ProviderClass,
    pub input_sample_rate: u32,
    pub output_sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionConfigured {
    pub interaction_profile: InteractionProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputAudioFrame {
    pub audio_b64: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub frame_duration_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputAudioGap {
    pub missing_duration_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Observation {
    pub speech_probability: f32,
    pub echo_probability: f32,
    pub target_speaker_probability: f32,
    pub semantic_completeness: f32,
    pub prosodic_finality: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractionDecision {
    pub action: InteractionAction,
    pub confidence: f32,
    pub reversible: bool,
    pub reason: String,
    pub evidence_event_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResponseRequested {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputTextDelta {
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputTextFinal {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputAudioFrame {
    pub audio_b64: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub frame_duration_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputAudioCancel {
    pub requested_cutoff_us: u64,
    pub reason: String,
    pub fade_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputAudioPlayed {
    pub last_media_time_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderState {
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskCreated {
    pub task_id: Uuid,
    pub kind: String,
    pub conversation_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskResult {
    pub task_id: Uuid,
    pub conversation_version: u64,
    pub content: Value,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorEvent {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionAction {
    Listen,
    HoldFloor,
    Backchannel,
    StartResponse,
    SoftDuck,
    HardYield,
    Resume,
    Replan,
    Delegate,
    CancelTask,
    EndSession,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderClass {
    NativeDuplex,
    HybridStreaming,
    Cascade,
    Mock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionProfile {
    pub backchannels: BackchannelLevel,
    pub pause_tolerance_ms: u32,
    pub interruption_sensitivity: InterruptionSensitivity,
}

impl Default for InteractionProfile {
    fn default() -> Self {
        Self {
            backchannels: BackchannelLevel::Minimal,
            pause_tolerance_ms: 650,
            interruption_sensitivity: InterruptionSensitivity::Balanced,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackchannelLevel {
    Off,
    Minimal,
    Natural,
    Expressive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterruptionSensitivity {
    Conservative,
    Balanced,
    Responsive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderManifest {
    pub id: String,
    pub adapter_version: String,
    pub provider_class: ProviderClass,
    pub license_class: LicenseClass,
    pub modalities: ModalityCapabilities,
    pub duplex: DuplexCapabilities,
    pub audio: AudioCapabilities,
    pub control: ControlCapabilities,
    pub limits: ProviderLimits,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LicenseClass {
    Redistributable,
    UserDownload,
    ResearchOnly,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModalityCapabilities {
    pub input: Vec<Modality>,
    pub output: Vec<Modality>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Modality {
    Audio,
    Text,
    State,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
pub struct DuplexCapabilities {
    pub continuous_input_while_output: bool,
    pub native_turn_policy: bool,
    pub native_barge_in: bool,
    pub state_tokens: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioCapabilities {
    pub input_sample_rates: Vec<u32>,
    pub output_sample_rates: Vec<u32>,
    pub frame_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
pub struct ControlCapabilities {
    pub text_injection: bool,
    pub context_update: bool,
    pub voice_conditioning: bool,
    pub cancel_generation: bool,
    pub resume_generation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderLimits {
    pub max_session_seconds: u32,
    pub required_gpu_memory_gb: Option<u16>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_json() {
        let session_id = Uuid::new_v4();
        let envelope = EventEnvelope::new(
            session_id,
            "interaction",
            1,
            20_000,
            RealtimeEvent::InteractionDecision(InteractionDecision {
                action: InteractionAction::Listen,
                confidence: 0.9,
                reversible: true,
                reason: "user is still speaking".to_owned(),
                evidence_event_ids: Vec::new(),
            }),
        );

        let json = serde_json::to_string(&envelope).expect("serialize");
        let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(envelope, decoded);
    }

    #[test]
    fn default_profile_is_conservative_about_backchannels() {
        let profile = InteractionProfile::default();
        assert_eq!(profile.backchannels, BackchannelLevel::Minimal);
        assert_eq!(
            profile.interruption_sensitivity,
            InterruptionSensitivity::Balanced
        );
    }
}
