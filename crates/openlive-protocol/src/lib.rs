mod media;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: &str = "1.0";
/// Additive feature revision negotiated inside v1-compatible envelopes.
/// Keeping the envelope version stable allows v1 clients to continue working
/// while v2 peers discover richer features explicitly.
///
/// Revision history:
/// - 1: Capability offer/selected + visual input (Phase 6)
/// - 2: Capability offer/selected + visual input (Phase 6 — published)
/// - 3: Task & evidence orchestration + resume (Phase 7)
/// - 4: VisualCard + translation (26.7.15)
pub const PROTOCOL_REVISION: u16 = 4;

pub use media::{MediaKind, MediaPacket, MediaPacketError, PcmAudioFrame};

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
    CapabilityOffer(CapabilityOffer),
    CapabilitySelected(CapabilitySelected),
    VisualInput(VisualInput),
    VisualInputAccepted(VisualInputAccepted),
    VisualInputRejected(VisualInputRejected),
    Observation(Observation),
    EndpointingPrediction(EndpointingPrediction),
    InteractionDecision(InteractionDecision),
    OutputTextDelta(OutputTextDelta),
    OutputTextFinal(OutputTextFinal),
    OutputAudioCancel(OutputAudioCancel),
    OutputAudioPlayed(OutputAudioPlayed),
    ProviderState(ProviderState),
    TaskCreated(TaskCreated),
    TaskResult(TaskResult),
    // ── Phase 7: Task & Evidence Orchestration (additive v2 events) ──
    /// Explicit intent issued by the client ("set a reminder", "share a
    /// screenshot"). The gateway MUST acknowledge with `TaskAcknowledged`
    /// before doing any provider work, so the client always knows whether a
    /// task was accepted, queued, or rejected.
    TaskRequested(TaskRequested),
    /// Gateway receipt for a `TaskRequested`. Carries the negotiated deadline
    /// and any warnings (e.g. "visual context unavailable"). The client treats
    /// this as the single source of truth for task state — no implicit
    /// "accepted" assumption is permitted.
    TaskAcknowledged(TaskAcknowledged),
    /// Client-initiated cancellation of a pending or acknowledged task. The
    /// gateway responds with a single `TaskOutcome` whose `result` is
    /// `Cancelled`. If the task is already resolved, the cancel request is
    /// silently ignored (the ledger is append-only).
    TaskCancel(TaskCancel),
    /// Final outcome of a task with linked evidence ids. The gateway MUST
    /// include at least one evidence id per requested evidence type unless the
    /// task failed before any work was performed (in which case `error_code`
    /// is non-null and `evidence_ids` may be empty).
    TaskOutcome(TaskOutcome),
    /// Bidirectional link between a task and the proof (observation, tool call,
    /// transcript segment, visual frame) that supports it. Stored in the
    /// append-only ledger so resume replay never re-derives links from
    /// scratch.
    EvidenceLink(EvidenceLink),
    /// Client request to resume a previously opened session. The gateway
    /// replays buffered outcomes whose sequence is strictly greater than
    /// `last_sequence_seen`, with deduplication enforced server-side.
    SessionResume(SessionResume),
    LatencyMark(LatencyMark),
    Error(ErrorEvent),
    UserTranscriptDelta(UserTranscriptDelta),
    /// Rich inline card (weather, translation, tools surface, …).
    VisualCard(VisualCard),
    Ping,
    Pong,
}

/// Structured visual card for the Live Desk transcript (GPT-Live-style).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VisualCard {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub fields: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserTranscriptDelta {
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionCreated {
    pub model: String,
    pub provider_class: ProviderClass,
    pub input_sample_rate: u32,
    pub output_sample_rate: u32,
    pub media_transport: MediaTransport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaTransport {
    WebsocketBinaryPcm,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionConfigured {
    pub interaction_profile: InteractionProfile,
}

/// Client-side capability offer sent after session creation. Providers select
/// only features they can actually honor; omission means unsupported.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityOffer {
    pub protocol_revision: u16,
    pub client_id: String,
    pub requested_modalities: ModalityCapabilities,
    pub visual_input_policy: Option<VisualInputPolicy>,
    pub supports_resume: bool,
    pub supported_languages: Vec<String>,
}

/// Gateway response to a capability offer. The selected manifest is the single
/// source of truth for controls the client may enable during this session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilitySelected {
    pub protocol_revision: u16,
    pub provider_manifest: ProviderManifest,
    pub selected_input: Vec<Modality>,
    pub selected_output: Vec<Modality>,
    pub visual_mode: VisualInputMode,
    pub resume_supported: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualInputMode {
    Unsupported,
    ExplicitSnapshot,
    ContinuousFrames,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualInputPolicy {
    pub mode: VisualInputMode,
    pub max_width: u32,
    pub max_height: u32,
    pub max_bytes: u32,
    pub durable_retention: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualInputSource {
    Camera,
    Screen,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetentionClass {
    Ephemeral,
    Session,
    Durable,
}

/// A user-approved bounded image. Continuous video uses a distinct future
/// media transport and must never be inferred from this event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualInput {
    pub capture_id: Uuid,
    pub source: VisualInputSource,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u32,
    pub captured_at: String,
    pub retention: RetentionClass,
    pub consent: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualInputAccepted {
    pub capture_id: Uuid,
    pub provider_observation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualInputRejected {
    pub capture_id: Uuid,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Observation {
    pub speech_probability: f32,
    pub echo_probability: f32,
    pub target_speaker_probability: f32,
    pub turn_completion_confidence: f32,
    pub prosodic_finality: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_completion: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EndpointingPrediction {
    pub speech_duration_ms: u32,
    pub silence_duration_ms: u32,
    pub turn_completion_confidence: f32,
    pub prosodic_finality: f32,
    pub should_respond: bool,
    pub reason: String,
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
pub struct OutputTextDelta {
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputTextFinal {
    pub text: String,
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
    pub state: ProviderLifecycleState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLifecycleState {
    Transcribing,
    Reasoning,
    Synthesizing,
    Generating,
    NativeSpeechStarted,
    Complete,
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

// ────────────────────────────────────────────────────────────────────────────
// Phase 7: Task & Evidence Orchestration
// ────────────────────────────────────────────────────────────────────────────

/// Lifecycle states a task may occupy between `task_requested` and
/// `task_outcome`. Exposed as part of `TaskAcknowledged` so the client can
/// render a truthful badge without inferring state from latency.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Gateway accepted the task and queued it; no provider work started yet.
    Queued,
    /// Provider is actively working on the task.
    InProgress,
    /// Task cannot proceed without additional input (rare; surfaces a warning).
    Blocked,
}

/// Final disposition of a task. `Cancelled` is reserved for cases where the
/// client (or gateway) explicitly aborted before completion; `Failure` means
/// the provider attempted the task and could not satisfy it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskResultKind {
    Success,
    Failure,
    Cancelled,
}

/// Categories of evidence the gateway may attach to a task outcome. The
/// client requests these in `TaskRequested::evidence_required`; the gateway
/// MUST honor the request or include a warning.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    /// Transcript segment(s) relevant to the task.
    Transcript,
    /// Provider tool calls made on behalf of the task.
    ToolCall,
    /// Visual frame(s) linked to the task.
    Visual,
    /// Latency / sequence marks proving task acknowledgement timing.
    Timing,
}

/// Explicit intent issued by the client after capability negotiation.
///
/// Design notes:
/// - `task_id` is generated client-side so the client can correlate the
///   acknowledgement without waiting for a server-assigned id.
/// - `deadline_ms` is optional; when present, the gateway MUST abort and emit
///   a `TaskOutcome` with `result = Failure` if the deadline elapses before
///   the provider completes.
/// - `evidence_required` declares what proof the client expects. The gateway
///   never fabricates evidence; if a category cannot be satisfied, the
///   acknowledgement carries a warning instead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskRequested {
    pub task_id: Uuid,
    pub intent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_required: Vec<EvidenceKind>,
    /// Optional binding to a specific assistant generation. When present,
    /// the gateway only completes this task when that exact generation
    /// reaches `ProviderState::Complete`. When absent, the gateway binds
    /// the task to the next generation that starts after admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<Uuid>,
}

/// Client-initiated cancellation. The gateway emits exactly one
/// `TaskOutcome` with `result = Cancelled` in response, regardless of
/// whether the task was pending, acknowledged, or already being worked
/// on by the provider. If the task is already resolved (success/failure/
/// cancelled), the cancel request is a no-op — the ledger is append-only
/// and a second outcome is never emitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskCancel {
    pub task_id: Uuid,
    /// Optional human-readable reason, surfaced in the outcome summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Gateway receipt for a `TaskRequested`. Always emitted before any provider
/// work begins, so the client can render a truthful "Acknowledged" badge
/// without inferring it from silence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskAcknowledged {
    pub task_id: Uuid,
    pub status: TaskStatus,
    /// Absolute deadline (epoch millis). Equal to `task_requested.deadline_ms`
    /// when supplied, otherwise the gateway's own soft deadline (default
    /// 45 s). Always present so the client never has to guess.
    pub deadline_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Final outcome of a task. The gateway emits exactly one `TaskOutcome` per
/// `task_id`; replay on resume uses the original sequence number so the
/// client deduplicates rather than re-applying.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskOutcome {
    pub task_id: Uuid,
    pub result: TaskResultKind,
    /// Human-readable summary, e.g. "Reminder set for 3:00 PM".
    pub summary: String,
    /// Ids of evidence events (observations, tool calls, visual frames, etc.)
    /// that prove the outcome. Stored as `Uuid` so they round-trip with the
    /// envelope `event_id`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
}

/// Directionality of an evidence link. `TaskProof` is the canonical case:
/// evidence supporting a successful outcome. `TaskContext` is evidence the
/// gateway considered but did not directly cite. `TaskFailure` is evidence
/// explaining why a task failed (e.g. a provider error event).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLinkType {
    TaskProof,
    TaskContext,
    TaskFailure,
}

/// Bidirectional link between a task and an evidence event. Either
/// `source_id` is a `task_id` and `target_id` is an observation id, or vice
/// versa. The gateway stores both directions in the ledger so resume replay
/// can answer "what evidence supports task X?" and "which task did
/// observation Y support?" without recomputation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceLink {
    pub source_id: Uuid,
    pub target_id: Uuid,
    pub link_type: EvidenceLinkType,
    /// 0.0–1.0. Reflects how strongly the gateway believes the evidence
    /// supports the task. Defaults to 1.0 for direct proof.
    pub confidence: f32,
}

/// Client request to resume a previously opened session after a transport
/// drop. The gateway replays buffered outcomes and evidence links whose
/// sequence is strictly greater than `last_sequence_seen`, then resumes
/// normal event flow. Duplicate suppression is enforced server-side: if the
/// same `event_id` was already delivered to this session, the replay skips
/// it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionResume {
    pub session_id: Uuid,
    pub last_sequence_seen: u64,
    #[serde(default = "default_replay_evidence")]
    pub replay_evidence: bool,
}

fn default_replay_evidence() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LatencyPhase {
    ResponseCommitted,
    FirstProviderEvent,
    FirstTextDelta,
    FirstAudioFrame,
    ProviderComplete,
    CancelRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatencyMark {
    pub phase: LatencyPhase,
    pub elapsed_us: u64,
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
    HostedOnly,
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
    Image,
    Screen,
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

    #[test]
    fn visual_input_round_trips_without_implying_continuous_video() {
        let capture_id = Uuid::new_v4();
        let event = RealtimeEvent::VisualInput(VisualInput {
            capture_id,
            source: VisualInputSource::Screen,
            mime_type: "image/jpeg".to_owned(),
            width: 960,
            height: 540,
            byte_length: 128_000,
            captured_at: "2026-07-14T00:00:00Z".to_owned(),
            retention: RetentionClass::Ephemeral,
            consent: "explicit_button_press".to_owned(),
            data_url: "data:image/jpeg;base64,AA==".to_owned(),
        });
        let encoded = serde_json::to_string(&event).expect("serialize visual input");
        assert!(encoded.contains("\"type\":\"visual_input\""));
        assert!(encoded.contains("\"retention\":\"ephemeral\""));
        assert!(!encoded.contains("continuous_frames"));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode visual input");
        assert_eq!(event, decoded);
    }

    #[test]
    fn capability_offer_serializes_as_additive_v1_event() {
        let envelope = EventEnvelope::new(
            Uuid::new_v4(),
            "capability",
            1,
            0,
            RealtimeEvent::CapabilityOffer(CapabilityOffer {
                protocol_revision: PROTOCOL_REVISION,
                client_id: "openlive-web-v2".to_owned(),
                requested_modalities: ModalityCapabilities {
                    input: vec![Modality::Audio, Modality::Text, Modality::Image],
                    output: vec![Modality::Audio, Modality::Text, Modality::State],
                },
                visual_input_policy: Some(VisualInputPolicy {
                    mode: VisualInputMode::ExplicitSnapshot,
                    max_width: 1280,
                    max_height: 720,
                    max_bytes: 393_216,
                    durable_retention: false,
                }),
                supports_resume: true,
                supported_languages: vec!["en".to_owned()],
            }),
        );
        let encoded = serde_json::to_string(&envelope).expect("serialize capability offer");
        assert!(encoded.contains("\"protocol_version\":\"1.0\""));
        assert!(encoded.contains("\"protocol_revision\":4"));
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 7: Task & Evidence Orchestration — serialization tests
    // ────────────────────────────────────────────────────────────────────────

    #[test]
    fn task_requested_round_trips_with_optional_fields_omitted() {
        let task_id = Uuid::new_v4();
        let event = RealtimeEvent::TaskRequested(TaskRequested {
            task_id,
            intent: "Set a reminder for 3pm".to_owned(),
            context: None,
            deadline_ms: None,
            evidence_required: Vec::new(),
            generation_id: None,
        });
        let encoded = serde_json::to_string(&event).expect("serialize task_requested");
        assert!(encoded.contains("\"type\":\"task_requested\""));
        // Optional fields with skip_serializing_if must not appear when None.
        assert!(!encoded.contains("context"));
        assert!(!encoded.contains("deadline_ms"));
        assert!(!encoded.contains("evidence_required"));
        assert!(!encoded.contains("generation_id"));
        let decoded: RealtimeEvent =
            serde_json::from_str(&encoded).expect("decode task_requested");
        assert_eq!(event, decoded);
    }

    #[test]
    fn task_acknowledged_round_trips_with_status_and_deadline() {
        let task_id = Uuid::new_v4();
        let event = RealtimeEvent::TaskAcknowledged(TaskAcknowledged {
            task_id,
            status: TaskStatus::Queued,
            deadline_ms: 45_000,
            provider_id: Some("openlive/mock-duplex".to_owned()),
            warnings: vec!["visual context unavailable".to_owned()],
        });
        let encoded = serde_json::to_string(&event).expect("serialize task_acknowledged");
        assert!(encoded.contains("\"type\":\"task_acknowledged\""));
        assert!(encoded.contains("\"status\":\"queued\""));
        assert!(encoded.contains("\"deadline_ms\":45000"));
        let decoded: RealtimeEvent =
            serde_json::from_str(&encoded).expect("decode task_acknowledged");
        assert_eq!(event, decoded);
    }

    #[test]
    fn task_outcome_round_trips_with_evidence_and_error() {
        let task_id = Uuid::new_v4();
        let proof_a = Uuid::new_v4();
        let proof_b = Uuid::new_v4();
        let event = RealtimeEvent::TaskOutcome(TaskOutcome {
            task_id,
            result: TaskResultKind::Failure,
            summary: "Provider rejected the requested tool".to_owned(),
            evidence_ids: vec![proof_a, proof_b],
            error_code: Some("TOOL_UNSUPPORTED".to_owned()),
            error_detail: Some("The selected provider does not implement calendar tools".to_owned()),
        });
        let encoded = serde_json::to_string(&event).expect("serialize task_outcome");
        assert!(encoded.contains("\"type\":\"task_outcome\""));
        assert!(encoded.contains("\"result\":\"failure\""));
        assert!(encoded.contains("\"evidence_ids\""));
        assert!(encoded.contains("\"error_code\":\"TOOL_UNSUPPORTED\""));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode task_outcome");
        assert_eq!(event, decoded);
    }

    #[test]
    fn evidence_link_round_trips_with_confidence() {
        let source = Uuid::new_v4();
        let target = Uuid::new_v4();
        let event = RealtimeEvent::EvidenceLink(EvidenceLink {
            source_id: source,
            target_id: target,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 0.87,
        });
        let encoded = serde_json::to_string(&event).expect("serialize evidence_link");
        assert!(encoded.contains("\"type\":\"evidence_link\""));
        assert!(encoded.contains("\"link_type\":\"task_proof\""));
        assert!(encoded.contains("\"confidence\":0.87"));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode evidence_link");
        assert_eq!(event, decoded);
    }

    #[test]
    fn session_resume_round_trips_and_defaults_replay_to_true() {
        let session_id = Uuid::new_v4();
        // Explicitly constructed with replay_evidence=false.
        let event = RealtimeEvent::SessionResume(SessionResume {
            session_id,
            last_sequence_seen: 42,
            replay_evidence: false,
        });
        let encoded = serde_json::to_string(&event).expect("serialize session_resume");
        assert!(encoded.contains("\"type\":\"session_resume\""));
        assert!(encoded.contains("\"last_sequence_seen\":42"));
        assert!(encoded.contains("\"replay_evidence\":false"));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode session_resume");
        assert_eq!(event, decoded);

        // When the client omits replay_evidence, the server must default to
        // true. We simulate that by decoding a JSON payload that lacks the
        // field entirely.
        let minimal = format!(
            r#"{{"type":"session_resume","payload":{{"session_id":"{session_id}","last_sequence_seen":7}}}}"#
        );
        let decoded_min: RealtimeEvent =
            serde_json::from_str(&minimal).expect("decode minimal session_resume");
        let RealtimeEvent::SessionResume(resume) = decoded_min else {
            panic!("expected SessionResume variant");
        };
        assert_eq!(resume.last_sequence_seen, 7);
        assert!(
            resume.replay_evidence,
            "replay_evidence must default to true so a client that forgets the field still receives buffered outcomes"
        );
    }

    #[test]
    fn task_cancel_round_trips_with_optional_reason() {
        let task_id = Uuid::new_v4();
        // With reason.
        let event = RealtimeEvent::TaskCancel(TaskCancel {
            task_id,
            reason: Some("user changed their mind".to_owned()),
        });
        let encoded = serde_json::to_string(&event).expect("serialize task_cancel");
        assert!(encoded.contains("\"type\":\"task_cancel\""));
        assert!(encoded.contains("\"reason\":\"user changed their mind\""));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode task_cancel");
        assert_eq!(event, decoded);

        // Without reason — the field must be omitted, not null.
        let minimal = RealtimeEvent::TaskCancel(TaskCancel {
            task_id,
            reason: None,
        });
        let encoded = serde_json::to_string(&minimal).expect("serialize minimal task_cancel");
        assert!(!encoded.contains("reason"));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode minimal");
        assert_eq!(minimal, decoded);
    }

    #[test]
    fn task_requested_round_trips_with_generation_binding() {
        let task_id = Uuid::new_v4();
        let generation_id = Uuid::new_v4();
        let event = RealtimeEvent::TaskRequested(TaskRequested {
            task_id,
            intent: "Remind me".to_owned(),
            context: None,
            deadline_ms: Some(5_000),
            evidence_required: vec![EvidenceKind::Transcript],
            generation_id: Some(generation_id),
        });
        let encoded = serde_json::to_string(&event).expect("serialize");
        assert!(encoded.contains("\"generation_id\""));
        let decoded: RealtimeEvent = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(event, decoded);

        // Without generation_id — must be omitted.
        let unbound = RealtimeEvent::TaskRequested(TaskRequested {
            task_id,
            intent: "Remind me".to_owned(),
            context: None,
            deadline_ms: None,
            evidence_required: Vec::new(),
            generation_id: None,
        });
        let encoded = serde_json::to_string(&unbound).expect("serialize unbound");
        assert!(!encoded.contains("generation_id"));
    }
}
