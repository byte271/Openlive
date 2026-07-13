use openlive_protocol::{
    BackchannelLevel, EventEnvelope, InteractionAction, InteractionDecision, InteractionProfile,
    InterruptionSensitivity, Observation, RealtimeEvent,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChronosConfig {
    pub speech_on_threshold: f32,
    pub speech_off_threshold: f32,
    pub barge_in_commit_ms: u32,
    pub minimum_user_turn_ms: u32,
    pub semantic_commit_threshold: f32,
    pub backchannel_after_ms: u32,
    pub backchannel_spacing_ms: u32,
}

impl Default for ChronosConfig {
    fn default() -> Self {
        Self {
            speech_on_threshold: 0.62,
            speech_off_threshold: 0.34,
            barge_in_commit_ms: 180,
            minimum_user_turn_ms: 280,
            semantic_commit_threshold: 0.55,
            backchannel_after_ms: 1_800,
            backchannel_spacing_ms: 3_500,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FloorState {
    Listening,
    UserSpeaking {
        since_us: u64,
    },
    UserPause {
        speech_since_us: u64,
        silence_since_us: u64,
    },
    ResponsePending,
    AssistantSpeaking {
        generation_id: Uuid,
    },
    SoftDucked {
        generation_id: Uuid,
        overlap_since_us: u64,
    },
    Yielded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChronosDecision {
    pub action: InteractionAction,
    pub confidence: f32,
    pub reversible: bool,
    pub reason: String,
    pub evidence_event_ids: Vec<Uuid>,
}

impl ChronosDecision {
    fn new(
        action: InteractionAction,
        confidence: f32,
        reversible: bool,
        reason: impl Into<String>,
        event_id: Uuid,
    ) -> Self {
        Self {
            action,
            confidence: confidence.clamp(0.0, 1.0),
            reversible,
            reason: reason.into(),
            evidence_event_ids: vec![event_id],
        }
    }
}

#[derive(Debug, Clone)]
pub struct Chronos {
    config: ChronosConfig,
    profile: InteractionProfile,
    state: FloorState,
    last_backchannel_us: Option<u64>,
}

impl Chronos {
    #[must_use]
    pub fn new(config: ChronosConfig, profile: InteractionProfile) -> Self {
        Self {
            config,
            profile,
            state: FloorState::Listening,
            last_backchannel_us: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> FloorState {
        self.state
    }

    pub fn update_profile(&mut self, profile: InteractionProfile) {
        self.profile = profile;
    }

    pub fn mark_response_started(&mut self, generation_id: Uuid) {
        self.state = FloorState::AssistantSpeaking { generation_id };
    }

    pub fn mark_response_complete(&mut self, generation_id: Uuid) {
        match self.state {
            FloorState::AssistantSpeaking {
                generation_id: active,
            }
            | FloorState::SoftDucked {
                generation_id: active,
                ..
            } if active == generation_id => {
                self.state = FloorState::Listening;
            }
            _ => {}
        }
    }

    pub fn observe(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        observation: &Observation,
    ) -> Vec<ChronosDecision> {
        let effective_speech = effective_speech_probability(observation);
        let decision = match self.state {
            FloorState::Listening => {
                self.observe_listening(event_id, media_time_us, effective_speech)
            }
            FloorState::UserSpeaking { since_us } => self.observe_user_speaking(
                event_id,
                media_time_us,
                effective_speech,
                since_us,
                observation,
            ),
            FloorState::UserPause {
                speech_since_us,
                silence_since_us,
            } => self.observe_user_pause(
                event_id,
                media_time_us,
                effective_speech,
                speech_since_us,
                silence_since_us,
                observation,
            ),
            FloorState::ResponsePending => {
                self.observe_response_pending(event_id, media_time_us, effective_speech)
            }
            FloorState::AssistantSpeaking { generation_id } => self.observe_assistant_speaking(
                event_id,
                media_time_us,
                effective_speech,
                generation_id,
            ),
            FloorState::SoftDucked {
                generation_id,
                overlap_since_us,
            } => self.observe_soft_ducked(
                event_id,
                media_time_us,
                effective_speech,
                generation_id,
                overlap_since_us,
            ),
            FloorState::Yielded => self.observe_yielded(event_id, media_time_us, effective_speech),
        };

        decision.into_iter().collect()
    }

    fn observe_listening(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
    ) -> Option<ChronosDecision> {
        if effective_speech < self.speech_on_threshold() {
            return None;
        }
        self.state = FloorState::UserSpeaking {
            since_us: media_time_us,
        };
        Some(ChronosDecision::new(
            InteractionAction::Listen,
            effective_speech,
            true,
            "target-like user speech started",
            event_id,
        ))
    }

    fn observe_user_speaking(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
        since_us: u64,
        observation: &Observation,
    ) -> Option<ChronosDecision> {
        if effective_speech <= self.config.speech_off_threshold {
            self.state = FloorState::UserPause {
                speech_since_us: since_us,
                silence_since_us: media_time_us,
            };
            return Some(ChronosDecision::new(
                InteractionAction::HoldFloor,
                1.0 - effective_speech,
                true,
                "speech paused; preserving the user's floor",
                event_id,
            ));
        }
        if observation.semantic_completeness < self.config.semantic_commit_threshold
            && self.should_backchannel(media_time_us, since_us)
        {
            self.last_backchannel_us = Some(media_time_us);
            return Some(ChronosDecision::new(
                InteractionAction::Backchannel,
                observation.semantic_completeness.mul_add(-0.4, 0.9),
                true,
                "long user turn with low semantic completeness",
                event_id,
            ));
        }
        None
    }

    fn observe_user_pause(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
        speech_since_us: u64,
        silence_since_us: u64,
        observation: &Observation,
    ) -> Option<ChronosDecision> {
        if effective_speech >= self.speech_on_threshold() {
            self.state = FloorState::UserSpeaking {
                since_us: speech_since_us,
            };
            return Some(ChronosDecision::new(
                InteractionAction::Listen,
                effective_speech,
                true,
                "user resumed after a thinking pause",
                event_id,
            ));
        }
        if !self.should_commit_response(
            media_time_us,
            speech_since_us,
            silence_since_us,
            observation,
        ) {
            return None;
        }
        self.state = FloorState::ResponsePending;
        Some(ChronosDecision::new(
            InteractionAction::StartResponse,
            response_commit_confidence(observation),
            false,
            "pause and completion signals indicate a finished turn",
            event_id,
        ))
    }

    fn observe_response_pending(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
    ) -> Option<ChronosDecision> {
        if effective_speech < self.speech_on_threshold() {
            return None;
        }
        self.state = FloorState::UserSpeaking {
            since_us: media_time_us,
        };
        Some(ChronosDecision::new(
            InteractionAction::Replan,
            effective_speech,
            false,
            "user resumed before response playback began",
            event_id,
        ))
    }

    fn observe_assistant_speaking(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
        generation_id: Uuid,
    ) -> Option<ChronosDecision> {
        if effective_speech < self.speech_on_threshold() {
            return None;
        }
        self.state = FloorState::SoftDucked {
            generation_id,
            overlap_since_us: media_time_us,
        };
        Some(ChronosDecision::new(
            InteractionAction::SoftDuck,
            effective_speech,
            true,
            "possible user barge-in; attenuate before committing",
            event_id,
        ))
    }

    fn observe_soft_ducked(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
        generation_id: Uuid,
        overlap_since_us: u64,
    ) -> Option<ChronosDecision> {
        if effective_speech <= self.config.speech_off_threshold {
            self.state = FloorState::AssistantSpeaking { generation_id };
            return Some(ChronosDecision::new(
                InteractionAction::Resume,
                1.0 - effective_speech,
                true,
                "overlap ended before barge-in commitment",
                event_id,
            ));
        }
        if elapsed_ms(media_time_us, overlap_since_us) < u64::from(self.barge_in_commit_ms()) {
            return None;
        }
        self.state = FloorState::Yielded;
        Some(ChronosDecision::new(
            InteractionAction::HardYield,
            effective_speech,
            false,
            "sustained target-like speech confirms interruption",
            event_id,
        ))
    }

    fn observe_yielded(
        &mut self,
        event_id: Uuid,
        media_time_us: u64,
        effective_speech: f32,
    ) -> Option<ChronosDecision> {
        if effective_speech < self.speech_on_threshold() {
            self.state = FloorState::Listening;
            return None;
        }
        self.state = FloorState::UserSpeaking {
            since_us: media_time_us,
        };
        Some(ChronosDecision::new(
            InteractionAction::Listen,
            effective_speech,
            true,
            "assistant yielded the floor to the user",
            event_id,
        ))
    }

    fn should_backchannel(&self, media_time_us: u64, speech_since_us: u64) -> bool {
        if matches!(self.profile.backchannels, BackchannelLevel::Off) {
            return false;
        }
        if elapsed_ms(media_time_us, speech_since_us) < u64::from(self.config.backchannel_after_ms)
        {
            return false;
        }
        self.last_backchannel_us.is_none_or(|last| {
            elapsed_ms(media_time_us, last) >= u64::from(self.config.backchannel_spacing_ms)
        })
    }

    fn speech_on_threshold(&self) -> f32 {
        match self.profile.interruption_sensitivity {
            InterruptionSensitivity::Conservative => {
                (self.config.speech_on_threshold + 0.1).min(0.9)
            }
            InterruptionSensitivity::Balanced => self.config.speech_on_threshold,
            InterruptionSensitivity::Responsive => {
                (self.config.speech_on_threshold - 0.12).max(0.4)
            }
        }
    }

    fn barge_in_commit_ms(&self) -> u32 {
        match self.profile.interruption_sensitivity {
            InterruptionSensitivity::Conservative => self.config.barge_in_commit_ms + 80,
            InterruptionSensitivity::Balanced => self.config.barge_in_commit_ms,
            InterruptionSensitivity::Responsive => {
                self.config.barge_in_commit_ms.saturating_sub(60).max(80)
            }
        }
    }

    fn should_commit_response(
        &self,
        media_time_us: u64,
        speech_since_us: u64,
        silence_since_us: u64,
        observation: &Observation,
    ) -> bool {
        let speech_ms = elapsed_ms(silence_since_us, speech_since_us);
        let silence_ms = elapsed_ms(media_time_us, silence_since_us);
        let complete = observation.semantic_completeness >= self.config.semantic_commit_threshold
            || observation.prosodic_finality >= self.config.semantic_commit_threshold;

        speech_ms >= u64::from(self.config.minimum_user_turn_ms)
            && silence_ms >= u64::from(self.profile.pause_tolerance_ms)
            && complete
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("session mismatch: expected {expected}, received {received}")]
    SessionMismatch { expected: Uuid, received: Uuid },
    #[error("events must be monotonic: previous {previous}, received {received}")]
    NonMonotonicMediaTime { previous: u64, received: u64 },
}

#[derive(Debug)]
pub struct SessionEngine {
    session_id: Uuid,
    sequence: u64,
    last_media_time_us: u64,
    chronos: Chronos,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnswerLease {
    pub lease_id: Uuid,
    pub conversation_version: u64,
    pub generation_id: Uuid,
}

#[derive(Debug)]
pub struct AnswerLeaseManager {
    session_id: Uuid,
    conversation_version: u64,
    lease_sequence: u64,
    user_turn_open: bool,
    active: Option<AnswerLease>,
}

impl AnswerLeaseManager {
    #[must_use]
    pub const fn new(session_id: Uuid) -> Self {
        Self {
            session_id,
            conversation_version: 0,
            lease_sequence: 0,
            user_turn_open: false,
            active: None,
        }
    }

    pub fn begin_user_turn(&mut self) {
        if self.user_turn_open {
            return;
        }
        self.conversation_version = self.conversation_version.saturating_add(1);
        self.user_turn_open = true;
        self.active = None;
    }

    pub fn issue(&mut self, generation_id: Uuid) -> AnswerLease {
        self.lease_sequence = self.lease_sequence.saturating_add(1);
        self.user_turn_open = false;
        let name = format!(
            "answer:{}:{}",
            self.conversation_version, self.lease_sequence
        );
        let lease = AnswerLease {
            lease_id: Uuid::new_v5(&self.session_id, name.as_bytes()),
            conversation_version: self.conversation_version,
            generation_id,
        };
        self.active = Some(lease);
        lease
    }

    pub fn revoke(&mut self, generation_id: Uuid) {
        if self
            .active
            .is_some_and(|lease| lease.generation_id == generation_id)
        {
            self.active = None;
        }
    }

    #[must_use]
    pub fn accepts(&self, generation_id: Uuid) -> bool {
        self.active
            .is_some_and(|lease| lease.generation_id == generation_id)
    }

    #[must_use]
    pub const fn active(&self) -> Option<AnswerLease> {
        self.active
    }
}

impl SessionEngine {
    #[must_use]
    pub fn new(session_id: Uuid, config: ChronosConfig, profile: InteractionProfile) -> Self {
        Self {
            session_id,
            sequence: 0,
            last_media_time_us: 0,
            chronos: Chronos::new(config, profile),
        }
    }

    #[must_use]
    pub const fn floor_state(&self) -> FloorState {
        self.chronos.state()
    }

    pub fn update_profile(&mut self, profile: InteractionProfile) {
        self.chronos.update_profile(profile);
    }

    pub fn mark_response_started(&mut self, generation_id: Uuid) {
        self.chronos.mark_response_started(generation_id);
    }

    pub fn mark_response_complete(&mut self, generation_id: Uuid) {
        self.chronos.mark_response_complete(generation_id);
    }

    /// Processes one event against the session's media timeline.
    ///
    /// # Errors
    ///
    /// Returns an error when the event belongs to another session or moves
    /// backward on the media timeline.
    pub fn process(
        &mut self,
        envelope: &EventEnvelope,
    ) -> Result<Vec<EventEnvelope>, RuntimeError> {
        if envelope.session_id != self.session_id {
            return Err(RuntimeError::SessionMismatch {
                expected: self.session_id,
                received: envelope.session_id,
            });
        }
        if envelope.media_time_us < self.last_media_time_us {
            return Err(RuntimeError::NonMonotonicMediaTime {
                previous: self.last_media_time_us,
                received: envelope.media_time_us,
            });
        }
        self.last_media_time_us = envelope.media_time_us;

        let RealtimeEvent::Observation(observation) = &envelope.event else {
            return Ok(Vec::new());
        };

        let decisions =
            self.chronos
                .observe(envelope.event_id, envelope.media_time_us, observation);
        Ok(decisions
            .into_iter()
            .map(|decision| {
                self.sequence += 1;
                let event_id =
                    deterministic_event_id(self.session_id, self.sequence, envelope.event_id);
                EventEnvelope::new_with_id(
                    event_id,
                    self.session_id,
                    "interaction",
                    self.sequence,
                    envelope.media_time_us,
                    RealtimeEvent::InteractionDecision(InteractionDecision {
                        action: decision.action,
                        confidence: decision.confidence,
                        reversible: decision.reversible,
                        reason: decision.reason,
                        evidence_event_ids: decision.evidence_event_ids,
                    }),
                )
                .with_parent(envelope.event_id)
            })
            .collect())
    }
}

/// Replays a sequence through a fresh deterministic session engine.
///
/// # Errors
///
/// Returns an error when any event has the wrong session identifier or a
/// decreasing media timestamp.
pub fn replay(
    session_id: Uuid,
    config: ChronosConfig,
    profile: InteractionProfile,
    events: &[EventEnvelope],
) -> Result<Vec<EventEnvelope>, RuntimeError> {
    let mut engine = SessionEngine::new(session_id, config, profile);
    let mut output = Vec::new();
    for event in events {
        output.extend(engine.process(event)?);
    }
    Ok(output)
}

fn effective_speech_probability(observation: &Observation) -> f32 {
    let echo_suppression = 1.0 - observation.echo_probability.clamp(0.0, 1.0);
    let target_weight = observation.target_speaker_probability.clamp(0.0, 1.0);
    (observation.speech_probability * echo_suppression * target_weight).clamp(0.0, 1.0)
}

fn response_commit_confidence(observation: &Observation) -> f32 {
    (observation.semantic_completeness * 0.55 + observation.prosodic_finality * 0.45)
        .clamp(0.0, 1.0)
}

fn deterministic_event_id(session_id: Uuid, sequence: u64, parent_event_id: Uuid) -> Uuid {
    let name = format!("interaction:{sequence}:{parent_event_id}");
    Uuid::new_v5(&session_id, name.as_bytes())
}

const fn elapsed_ms(later_us: u64, earlier_us: u64) -> u64 {
    later_us.saturating_sub(earlier_us) / 1_000
}

#[cfg(test)]
mod tests {
    use openlive_protocol::{EventEnvelope, Observation, RealtimeEvent};

    use super::*;

    fn observation_event(
        session_id: Uuid,
        sequence: u64,
        media_time_us: u64,
        speech_probability: f32,
        completeness: f32,
    ) -> EventEnvelope {
        EventEnvelope::new(
            session_id,
            "observations",
            sequence,
            media_time_us,
            RealtimeEvent::Observation(Observation {
                speech_probability,
                echo_probability: 0.0,
                target_speaker_probability: 1.0,
                semantic_completeness: completeness,
                prosodic_finality: completeness,
            }),
        )
    }

    fn action(event: &EventEnvelope) -> InteractionAction {
        let RealtimeEvent::InteractionDecision(decision) = &event.event else {
            panic!("expected decision");
        };
        decision.action
    }

    #[test]
    fn waits_through_short_pause_then_starts_response() {
        let session_id = Uuid::new_v4();
        let events = vec![
            observation_event(session_id, 1, 0, 0.9, 0.1),
            observation_event(session_id, 2, 600_000, 0.1, 0.7),
            observation_event(session_id, 3, 1_100_000, 0.1, 0.8),
            observation_event(session_id, 4, 1_300_000, 0.1, 0.8),
        ];

        let output = replay(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
            &events,
        )
        .expect("replay");

        let actions: Vec<_> = output.iter().map(action).collect();
        assert_eq!(
            actions,
            vec![
                InteractionAction::Listen,
                InteractionAction::HoldFloor,
                InteractionAction::StartResponse
            ]
        );
    }

    #[test]
    fn reversible_duck_precedes_hard_yield() {
        let session_id = Uuid::new_v4();
        let generation_id = Uuid::new_v4();
        let mut engine = SessionEngine::new(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
        );
        engine.mark_response_started(generation_id);

        let first = engine
            .process(&observation_event(session_id, 1, 0, 0.9, 0.0))
            .expect("first");
        let second = engine
            .process(&observation_event(session_id, 2, 200_000, 0.9, 0.0))
            .expect("second");

        assert_eq!(action(&first[0]), InteractionAction::SoftDuck);
        assert_eq!(action(&second[0]), InteractionAction::HardYield);
    }

    #[test]
    fn brief_overlap_resumes_instead_of_canceling() {
        let session_id = Uuid::new_v4();
        let generation_id = Uuid::new_v4();
        let mut engine = SessionEngine::new(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
        );
        engine.mark_response_started(generation_id);

        engine
            .process(&observation_event(session_id, 1, 0, 0.9, 0.0))
            .expect("duck");
        let output = engine
            .process(&observation_event(session_id, 2, 100_000, 0.1, 0.0))
            .expect("resume");

        assert_eq!(action(&output[0]), InteractionAction::Resume);
    }

    #[test]
    fn rejects_non_monotonic_media_time() {
        let session_id = Uuid::new_v4();
        let mut engine = SessionEngine::new(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
        );
        engine
            .process(&observation_event(session_id, 1, 100_000, 0.0, 0.0))
            .expect("first");

        let error = engine
            .process(&observation_event(session_id, 2, 99_000, 0.0, 0.0))
            .expect_err("must reject");
        assert!(matches!(error, RuntimeError::NonMonotonicMediaTime { .. }));
    }

    #[test]
    fn replay_emits_stable_event_ids() {
        let session_id = Uuid::new_v4();
        let events = vec![
            observation_event(session_id, 1, 0, 0.9, 0.1),
            observation_event(session_id, 2, 600_000, 0.1, 0.7),
            observation_event(session_id, 3, 1_300_000, 0.1, 0.8),
        ];

        let first = replay(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
            &events,
        )
        .expect("first replay");
        let second = replay(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
            &events,
        )
        .expect("second replay");

        assert_eq!(first, second);
    }

    #[test]
    fn stale_answer_lease_is_rejected_after_new_turn() {
        let session_id = Uuid::new_v4();
        let first_generation = Uuid::new_v4();
        let second_generation = Uuid::new_v4();
        let mut leases = AnswerLeaseManager::new(session_id);

        leases.begin_user_turn();
        leases.issue(first_generation);
        assert!(leases.accepts(first_generation));

        leases.begin_user_turn();
        assert!(!leases.accepts(first_generation));
        leases.issue(second_generation);
        assert!(leases.accepts(second_generation));
    }
}
