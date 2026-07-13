use std::time::Instant;

use openlive_protocol::{LatencyMark, LatencyPhase, ProviderLifecycleState, RealtimeEvent};
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct ActiveGeneration {
    pub id: Uuid,
    pub base_media_time_us: u64,
    pub latency: LatencyTracker,
}

#[derive(Debug)]
pub(crate) struct LatencyTracker {
    started_at: Instant,
    first_provider_event: bool,
    first_text_delta: bool,
    first_audio_frame: bool,
}

impl LatencyTracker {
    pub(crate) fn new() -> Self {
        Self {
            started_at: Instant::now(),
            first_provider_event: false,
            first_text_delta: false,
            first_audio_frame: false,
        }
    }

    pub(crate) fn observe(&mut self, event: &RealtimeEvent) -> Vec<LatencyMark> {
        let mut marks = Vec::new();
        if !self.first_provider_event {
            self.first_provider_event = true;
            marks.push(self.mark(LatencyPhase::FirstProviderEvent));
        }
        if matches!(event, RealtimeEvent::OutputTextDelta(_)) && !self.first_text_delta {
            self.first_text_delta = true;
            marks.push(self.mark(LatencyPhase::FirstTextDelta));
        }
        if matches!(event, RealtimeEvent::OutputAudioFrame(_)) && !self.first_audio_frame {
            self.first_audio_frame = true;
            marks.push(self.mark(LatencyPhase::FirstAudioFrame));
        }
        if matches!(
            event,
            RealtimeEvent::ProviderState(state)
                if state.state == ProviderLifecycleState::Complete
        ) {
            marks.push(self.mark(LatencyPhase::ProviderComplete));
        }
        marks
    }

    pub(crate) fn mark(&self, phase: LatencyPhase) -> LatencyMark {
        LatencyMark {
            phase,
            elapsed_us: u64::try_from(self.started_at.elapsed().as_micros()).unwrap_or(u64::MAX),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PlayoutTracker {
    last_sent_media_time_us: u64,
    last_played_media_time_us: u64,
}

impl PlayoutTracker {
    pub(crate) fn sent(&mut self, media_time_us: u64) {
        self.last_sent_media_time_us = self.last_sent_media_time_us.max(media_time_us);
    }

    pub(crate) fn played(&mut self, media_time_us: u64) {
        self.last_played_media_time_us = self.last_played_media_time_us.max(media_time_us);
    }

    pub(crate) const fn is_active(&self) -> bool {
        self.last_sent_media_time_us > self.last_played_media_time_us
    }

    pub(crate) fn cancel(&mut self) {
        self.last_played_media_time_us = self.last_sent_media_time_us;
    }
}

#[derive(Debug, Default)]
pub(crate) struct RepairContext {
    interrupted_generation_id: Option<Uuid>,
    interrupted_at_us: u64,
}

impl RepairContext {
    pub(crate) fn record_interruption(&mut self, generation_id: Uuid, media_time_us: u64) {
        self.interrupted_generation_id = Some(generation_id);
        self.interrupted_at_us = media_time_us;
    }

    pub(crate) fn take_prompt(&mut self) -> String {
        let Some(generation_id) = self.interrupted_generation_id.take() else {
            return String::new();
        };
        format!(
            "The user interrupted assistant generation {generation_id} at media time {} us. Treat the new user turn as higher priority, avoid repeating the interrupted answer, briefly acknowledge any correction if useful, and answer the new intent directly.",
            self.interrupted_at_us
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_context_is_one_shot() {
        let generation_id = Uuid::new_v4();
        let mut repair = RepairContext::default();
        repair.record_interruption(generation_id, 42_000);
        let prompt = repair.take_prompt();
        assert!(prompt.contains(&generation_id.to_string()));
        assert!(prompt.contains("higher priority"));
        assert!(repair.take_prompt().is_empty());
    }

    #[test]
    fn playout_tracks_monotonic_acknowledgements_and_cancel() {
        let mut playout = PlayoutTracker::default();
        playout.sent(40_000);
        playout.sent(20_000);
        assert!(playout.is_active());
        playout.played(10_000);
        assert!(playout.is_active());
        playout.played(40_000);
        assert!(!playout.is_active());
        playout.sent(60_000);
        playout.cancel();
        assert!(!playout.is_active());
    }
}
