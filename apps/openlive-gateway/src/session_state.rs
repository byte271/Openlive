use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

use openlive_protocol::{
    EvidenceKind, EvidenceLink, EvidenceLinkType, LatencyMark, LatencyPhase, ProviderLifecycleState,
    RealtimeEvent, TaskAcknowledged, TaskRequested, TaskResultKind, TaskStatus,
};
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
        if matches!(
            event,
            RealtimeEvent::ProviderState(state)
                if state.state == ProviderLifecycleState::Complete
        ) {
            marks.push(self.mark(LatencyPhase::ProviderComplete));
        }
        marks
    }

    pub(crate) fn observe_audio(&mut self) -> Vec<LatencyMark> {
        let mut marks = Vec::new();
        if !self.first_provider_event {
            self.first_provider_event = true;
            marks.push(self.mark(LatencyPhase::FirstProviderEvent));
        }
        if !self.first_audio_frame {
            self.first_audio_frame = true;
            marks.push(self.mark(LatencyPhase::FirstAudioFrame));
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
pub(crate) struct ClientTimeline {
    last_sequence: u64,
    stream_media_times: HashMap<String, u64>,
}

#[derive(Debug, Default)]
pub(crate) struct TelemetryGate {
    last_media_time_us: Option<u64>,
}

impl TelemetryGate {
    pub(crate) fn should_publish(&mut self, media_time_us: u64, force: bool) -> bool {
        let due = self
            .last_media_time_us
            .is_none_or(|last| media_time_us.saturating_sub(last) >= 100_000);
        if force || due {
            self.last_media_time_us = Some(media_time_us);
            true
        } else {
            false
        }
    }
}

impl ClientTimeline {
    pub(crate) fn observe(
        &mut self,
        sequence: u64,
        stream_id: &str,
        media_time_us: u64,
    ) -> Result<(), &'static str> {
        if sequence <= self.last_sequence {
            return Err("client sequence must increase");
        }
        if self
            .stream_media_times
            .get(stream_id)
            .is_some_and(|last| media_time_us < *last)
        {
            return Err("client media time must not move backward within a stream");
        }
        self.last_sequence = sequence;
        self.stream_media_times
            .insert(stream_id.to_owned(), media_time_us);
        Ok(())
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

// ────────────────────────────────────────────────────────────────────────────
// Phase 7+8: Task & Evidence Orchestration
// ────────────────────────────────────────────────────────────────────────────

/// Default soft deadline (epoch millis from acknowledgement) when the client
/// does not supply one. Chosen so a typical voice user has time to see the
/// "Acknowledged" badge and the provider has room to complete a tool call
/// without the gateway racing to abort.
///
/// Overridable at process start via `--task-deadline-ms` / `set_default_task_deadline_ms`.
pub(crate) const DEFAULT_TASK_DEADLINE_MS: u64 = 45_000;

static TASK_DEADLINE_MS: AtomicU64 = AtomicU64::new(DEFAULT_TASK_DEADLINE_MS);

/// Install the process-wide default task deadline (milliseconds). `0` means
/// “no implicit deadline” — admit will still accept an explicit client value.
pub(crate) fn set_default_task_deadline_ms(ms: u64) {
    TASK_DEADLINE_MS.store(ms, Ordering::Relaxed);
}

pub(crate) fn default_task_deadline_ms() -> u64 {
    TASK_DEADLINE_MS.load(Ordering::Relaxed)
}

/// How long the gateway keeps buffered outcomes for resume after a client
/// disconnect. Past this window, the gateway drops buffered events to bound
/// memory. 30 s matches the Phase 7 spec.
pub(crate) const RESUME_BUFFER_TTL_MS: u64 = 30_000;

/// Internal record of a task the gateway has acknowledged but not yet
/// resolved. Every field here is actively read by a code path — no dead
/// storage. `intent` is used to build the outcome summary; `deadline_ms`
/// is used by `expire_deadlines`; `generation_id` is used by
/// `complete_tasks_for_generation` to avoid completing tasks bound to a
/// different generation.
#[derive(Debug, Clone)]
pub(crate) struct TaskRecord {
    pub task_id: Uuid,
    pub intent: String,
    pub deadline_ms: u64,
    /// Generation this task is bound to. `None` means the task is waiting
    /// for the next generation to start; `bind_pending_to_generation`
    /// transitions it to `Some`.
    pub generation_id: Option<Uuid>,
    /// Evidence ids collected so far, grouped by the kind they satisfy.
    /// The orchestrator never fabricates entries here; ids are only added
    /// when a real provider event arrives that matches a requested kind.
    pub collected_evidence: HashMap<EvidenceKind, Vec<Uuid>>,
}

/// A buffered outbound envelope plus the wall-clock time it was buffered,
/// so the resume path can expire stale entries. The `sequence` is the
/// `BTreeMap` key; `event_id` is stored here so expiry can remove the
/// dedup-index entry without an O(n) reverse scan.
#[derive(Debug, Clone)]
pub(crate) struct BufferedEvent {
    pub event_id: Uuid,
    pub buffered_at: Instant,
    pub envelope_json: String,
}

/// Entry in the bidirectional evidence link index. We store both directions
/// so resume and query paths can answer "what proves task X?" and "which
/// task did observation Y support?" in O(1). `confidence` is preserved so
/// the evidence matrix can render link strength.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredEvidenceLink {
    pub source_id: Uuid,
    pub target_id: Uuid,
    pub link_type: EvidenceLinkType,
    pub confidence: f32,
}

/// A task that needs an outcome emitted. Returned by `expire_deadlines`
/// and `complete_tasks_for_generation` so the session handler can emit
/// each outcome on the wire. The orchestrator does NOT emit outcomes
/// itself — that stays in `session.rs` so all wire writes go through a
/// single egress point.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `intent` is preserved for future diagnostics and tests.
pub(crate) struct PendingOutcome {
    pub task_id: Uuid,
    pub intent: String,
    pub result: TaskResultKind,
    pub evidence_ids: Vec<Uuid>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub summary: String,
}

/// State machine that owns the lifecycle of every task the gateway has
/// acknowledged. The orchestrator is intentionally synchronous and in-memory:
/// it never starts provider work itself (that stays in `session.rs`), it
/// only validates intents, holds the canonical task state, and answers
/// resume queries.
///
/// Invariants enforced:
/// - At most one `TaskRecord` per `task_id` is active at a time.
/// - `BufferedEvent`s are append-only and deduplicated by `event_id`.
/// - `EvidenceLink`s are stored in both directions and deduplicated by the
///   `(source_id, target_id, link_type)` triple.
/// - `record_outcome` removes the active `TaskRecord` so a second outcome
///   for the same id is rejected.
/// - A task is only completed by the generation it is bound to (or by
///   deadline expiry / explicit cancel).
#[derive(Debug, Default)]
pub(crate) struct TaskOrchestrator {
    active: HashMap<Uuid, TaskRecord>,
    completed: HashMap<Uuid, TaskResultKind>,
    /// Buffered outbound envelopes, indexed TWO ways for O(1) dedup by
    /// `event_id` and O(log n) resume replay by sequence:
    ///   - `buffered_by_id`: `HashMap` for "have I already buffered this
    ///     `event_id`?" lookups (dedup guard).
    ///   - `buffered_by_seq`: `BTreeMap` keyed by sequence number for range
    ///     queries ("replay everything above `last_sequence_seen`").
    ///
    /// The `BufferedEvent` struct is stored in `buffered_by_seq` only;
    /// `buffered_by_id` holds the sequence number so we can find and
    /// remove the matching `BTreeMap` entry on dedup or expiry.
    buffered_by_id: HashMap<Uuid, u64>, // event_id → sequence
    buffered_by_seq: BTreeMap<u64, BufferedEvent>,
    /// Bidirectional link index. Keyed by both endpoints so a query from
    /// either side is O(1).
    links_by_source: HashMap<Uuid, Vec<StoredEvidenceLink>>,
    links_by_target: HashMap<Uuid, Vec<StoredEvidenceLink>>,
}

impl TaskOrchestrator {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Validate a `TaskRequested` and produce the matching
    /// `TaskAcknowledged`. Returns `None` if the task is rejected (empty
    /// intent, duplicate id). The caller is responsible for emitting the
    /// acknowledgement on the wire.
    ///
    /// If `request.generation_id` is `Some`, the task is bound to that
    /// generation immediately. Otherwise the task stays unbound until
    /// `bind_pending_to_generation` is called when the next generation
    /// starts.
    pub(crate) fn admit(
        &mut self,
        request: TaskRequested,
        provider_id: Option<&str>,
        now_ms: u64,
    ) -> Option<TaskAcknowledged> {
        if request.intent.trim().is_empty() {
            return None;
        }
        if self.active.contains_key(&request.task_id)
            || self.completed.contains_key(&request.task_id)
        {
            return None;
        }
        let default_deadline = default_task_deadline_ms();
        let deadline_ms = request.deadline_ms.unwrap_or_else(|| {
            if default_deadline == 0 {
                // Far-future sentinel when operator disabled default deadlines.
                now_ms.saturating_add(u64::from(u32::MAX))
            } else {
                now_ms.saturating_add(default_deadline)
            }
        });
        let mut warnings = Vec::new();
        if request
            .evidence_required
            .iter()
            .any(|kind| matches!(kind, EvidenceKind::Visual))
            && provider_id.is_none()
        {
            warnings.push("no provider bound to this task; visual evidence may be unavailable".to_owned());
        }
        let record = TaskRecord {
            task_id: request.task_id,
            intent: request.intent,
            deadline_ms,
            generation_id: request.generation_id,
            collected_evidence: HashMap::new(),
        };
        self.active.insert(request.task_id, record);
        Some(TaskAcknowledged {
            task_id: request.task_id,
            status: TaskStatus::Queued,
            deadline_ms,
            provider_id: provider_id.map(ToString::to_string),
            warnings,
        })
    }

    /// Bind every pending (unbound) task to `generation_id`. Called when a
    /// new generation starts so tasks admitted between turns get attached
    /// to the upcoming generation. Returns the ids of tasks that were
    /// bound (for diagnostics / logging).
    pub(crate) fn bind_pending_to_generation(
        &mut self,
        generation_id: Uuid,
    ) -> Vec<Uuid> {
        let mut bound = Vec::new();
        for record in self.active.values_mut() {
            if record.generation_id.is_none() {
                record.generation_id = Some(generation_id);
                bound.push(record.task_id);
            }
        }
        bound
    }

    /// Attach a piece of evidence (an observation/tool/transcript event id)
    /// to a task under a specific kind. Idempotent: re-adding the same
    /// `(task_id, kind, evidence_id)` triple is a no-op.
    pub(crate) fn attach_evidence(
        &mut self,
        task_id: Uuid,
        kind: EvidenceKind,
        evidence_id: Uuid,
    ) -> bool {
        let Some(record) = self.active.get_mut(&task_id) else {
            return false;
        };
        let bucket = record.collected_evidence.entry(kind).or_default();
        if bucket.contains(&evidence_id) {
            return false;
        }
        bucket.push(evidence_id);
        true
    }

    /// Record a bidirectional evidence link. Returns `true` if a new link
    /// was inserted, `false` if an identical link already existed. Both
    /// directions are indexed so resume and query paths can traverse from
    /// either side without scanning.
    pub(crate) fn link_evidence(&mut self, link: &EvidenceLink) -> bool {
        let stored = StoredEvidenceLink {
            source_id: link.source_id,
            target_id: link.target_id,
            link_type: link.link_type,
            confidence: link.confidence,
        };
        let from_source = self.links_by_source.entry(link.source_id).or_default();
        if from_source.contains(&stored) {
            return false;
        }
        from_source.push(stored.clone());
        self.links_by_target
            .entry(link.target_id)
            .or_default()
            .push(stored);
        true
    }

    /// Look up every evidence id linked to a task. Used by outcome
    /// emission to populate `evidence_ids` and by the bidirectional query
    /// path.
    pub(crate) fn evidence_for(&self, task_id: Uuid) -> Vec<Uuid> {
        self.links_by_source
            .get(&task_id)
            .into_iter()
            .flatten()
            .map(|link| link.target_id)
            .collect()
    }

    /// Look up every task that cited a given evidence id. Used by the
    /// evidence matrix UI to render "which task did this observation
    /// support?". Not yet wired into a gateway query event.
    #[allow(dead_code)] // Reserved for the evidence matrix query API.
    pub(crate) fn tasks_for_evidence(&self, evidence_id: Uuid) -> Vec<Uuid> {
        self.links_by_target
            .get(&evidence_id)
            .into_iter()
            .flatten()
            .map(|link| link.source_id)
            .collect()
    }

    /// Return the confidence of the strongest link between `task_id` and
    /// `evidence_id`, or `None` if no link exists. Used by the evidence
    /// matrix to render link strength.
    #[cfg(test)]
    pub(crate) fn link_confidence(
        &self,
        task_id: Uuid,
        evidence_id: Uuid,
    ) -> Option<f32> {
        self.links_by_source
            .get(&task_id)?
            .iter()
            .filter(|link| link.target_id == evidence_id)
            .map(|link| link.confidence)
            .fold(None, |acc, confidence| {
                Some(acc.map_or(confidence, |existing: f32| existing.max(confidence)))
            })
    }

    /// Return the task ids currently bound to `generation_id`. Used by
    /// the session handler to attach evidence only to tasks that belong
    /// to the emitting generation — this prevents evidence from one
    /// generation polluting tasks admitted for a different turn.
    pub(crate) fn task_ids_for_generation(&self, generation_id: Uuid) -> Vec<Uuid> {
        self.active
            .values()
            .filter(|record| record.generation_id == Some(generation_id))
            .map(|record| record.task_id)
            .collect()
    }

    /// Return the task ids whose deadline has elapsed and produce a
    /// `PendingOutcome` (Failure) for each. Called by the session handler
    /// on every provider emission so deadlines are enforced without
    /// spawning extra timers. The orchestrator does NOT emit the outcomes
    /// — the caller is responsible for sending them on the wire.
    pub(crate) fn expire_deadlines(&mut self, now_ms: u64) -> Vec<PendingOutcome> {
        let expired: Vec<Uuid> = self
            .active
            .values()
            .filter(|record| record.deadline_ms <= now_ms)
            .map(|record| record.task_id)
            .collect();
        let mut outcomes = Vec::new();
        for task_id in expired {
            let Some(record) = self.active.remove(&task_id) else {
                continue;
            };
            let evidence_ids = self.evidence_for(task_id);
            self.completed.insert(task_id, TaskResultKind::Failure);
            let summary = format!("“{}” timed out before completion", record.intent);
            let error_detail = Some(format!(
                "task deadline of {} ms elapsed before the provider completed",
                record.deadline_ms
            ));
            outcomes.push(PendingOutcome {
                task_id,
                intent: record.intent,
                result: TaskResultKind::Failure,
                evidence_ids,
                error_code: Some("DEADLINE_ELAPSED".to_owned()),
                error_detail,
                summary,
            });
        }
        outcomes
    }

    /// Cancel a task. Returns a `PendingOutcome` (Cancelled) if the task
    /// was active, or `None` if the task is unknown or already resolved.
    /// The caller emits the outcome on the wire.
    pub(crate) fn cancel_task(
        &mut self,
        task_id: Uuid,
        reason: Option<&str>,
    ) -> Option<PendingOutcome> {
        let record = self.active.remove(&task_id)?;
        let evidence_ids = self.evidence_for(task_id);
        self.completed.insert(task_id, TaskResultKind::Cancelled);
        let detail = reason.unwrap_or("cancelled by client").to_owned();
        let summary = format!("“{}” cancelled", record.intent);
        Some(PendingOutcome {
            task_id,
            intent: record.intent,
            result: TaskResultKind::Cancelled,
            evidence_ids,
            error_code: Some("CLIENT_CANCELLED".to_owned()),
            error_detail: Some(detail),
            summary,
        })
    }

    /// Complete every task bound to `generation_id`. Returns a
    /// `PendingOutcome` (Success) for each. Tasks bound to other
    /// generations are NOT completed — this is the correctness fix that
    /// prevents a finishing generation from completing tasks admitted for
    /// a future turn.
    pub(crate) fn complete_tasks_for_generation(
        &mut self,
        generation_id: Uuid,
    ) -> Vec<PendingOutcome> {
        let to_complete: Vec<Uuid> = self
            .active
            .values()
            .filter(|record| record.generation_id == Some(generation_id))
            .map(|record| record.task_id)
            .collect();
        let mut outcomes = Vec::new();
        for task_id in to_complete {
            let Some(record) = self.active.remove(&task_id) else {
                continue;
            };
            let evidence_ids = self.evidence_for(task_id);
            self.completed.insert(task_id, TaskResultKind::Success);
            let kinds: Vec<String> = record
                .collected_evidence
                .keys()
                .map(|kind| format!("{kind:?}").to_lowercase())
                .collect();
            let summary = if evidence_ids.is_empty() {
                format!("“{}” completed (no evidence collected)", record.intent)
            } else {
                format!(
                    "“{}” completed · {} evidence · {}",
                    record.intent,
                    evidence_ids.len(),
                    kinds.join(", ")
                )
            };
            outcomes.push(PendingOutcome {
                task_id,
                intent: record.intent,
                result: TaskResultKind::Success,
                evidence_ids,
                error_code: None,
                error_detail: None,
                summary,
            });
        }
        outcomes
    }

    /// Mark a task as resolved without producing a `PendingOutcome`. Used
    /// when the caller has already built the outcome (e.g. from
    /// `expire_deadlines` or `complete_tasks_for_generation`). Returns
    /// `true` if the task was active and is now resolved.
    #[cfg(test)]
    pub(crate) fn mark_resolved(&mut self, task_id: Uuid, result: TaskResultKind) -> bool {
        if self.active.remove(&task_id).is_some() {
            self.completed.insert(task_id, result);
            true
        } else {
            false
        }
    }

    /// Buffer an outbound envelope for resume replay. Deduplicated by
    /// `event_id`: re-buffering the same event is a no-op (and is the
    /// primary mechanism that keeps resume replay from duplicating
    /// evidence).
    ///
    /// Stored in two indexes:
    ///   - `buffered_by_id[event_id] = sequence` for O(1) dedup
    ///   - `buffered_by_seq[sequence] = BufferedEvent` for O(log n) replay
    pub(crate) fn buffer_outbound(
        &mut self,
        sequence: u64,
        event_id: Uuid,
        envelope_json: String,
    ) -> bool {
        if self.buffered_by_id.contains_key(&event_id) {
            return false;
        }
        let buffered = BufferedEvent {
            event_id,
            buffered_at: Instant::now(),
            envelope_json,
        };
        self.buffered_by_id.insert(event_id, sequence);
        self.buffered_by_seq.insert(sequence, buffered);
        true
    }

    /// Return the buffered envelopes whose sequence is strictly greater
    /// than `last_sequence_seen`, in ascending sequence order. Also
    /// expires entries older than `RESUME_BUFFER_TTL_MS` so a
    /// long-disconnected client does not receive stale outcomes.
    ///
    /// Uses the `BTreeMap`'s `range` iterator for O(log n) lookup of the
    /// starting point, then iterates only the relevant suffix. This is
    /// materially faster than the linear scan we used in v2.0.0 when the
    /// buffer holds many events (e.g. a long task with many evidence
    /// links).
    ///
    /// Returns the JSON strings directly so the caller can write them to
    /// the wire without re-serializing.
    pub(crate) fn replay_after(&mut self, last_sequence_seen: u64) -> Vec<String> {
        let now = Instant::now();
        let mut expired_seqs = Vec::new();
        let mut replay = Vec::new();
        // Range over (last_sequence_seen, +inf) — strictly greater.
        for (&seq, entry) in self.buffered_by_seq.range((std::ops::Bound::Excluded(last_sequence_seen), std::ops::Bound::Unbounded)) {
            let age_ms = u64::try_from(now.duration_since(entry.buffered_at).as_millis())
                .unwrap_or(u64::MAX);
            if age_ms > RESUME_BUFFER_TTL_MS {
                expired_seqs.push(seq);
                continue;
            }
            replay.push(entry.envelope_json.clone());
        }
        // Purge expired entries from both indexes. O(log n) per removal.
        for seq in expired_seqs {
            if let Some(entry) = self.buffered_by_seq.remove(&seq) {
                self.buffered_by_id.remove(&entry.event_id);
            }
        }
        replay
    }

    /// Number of currently active (acknowledged but not yet resolved)
    /// tasks. Exposed for tests.
    #[cfg(test)]
    pub(crate) fn active_count(&self) -> usize {
        self.active.len()
    }

    /// Number of buffered events currently held. Exposed for tests.
    #[cfg(test)]
    pub(crate) fn buffered_count(&self) -> usize {
        self.buffered_by_seq.len()
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

    #[test]
    fn client_timeline_rejects_replay_and_time_regression() {
        let mut timeline = ClientTimeline::default();
        assert!(timeline.observe(1, "microphone", 20_000).is_ok());
        assert_eq!(
            timeline.observe(1, "microphone", 20_000),
            Err("client sequence must increase")
        );
        assert_eq!(
            timeline.observe(2, "microphone", 10_000),
            Err("client media time must not move backward within a stream")
        );
        assert!(timeline.observe(3, "assistant_playout", 10_000).is_ok());
        assert!(timeline.observe(4, "microphone", 40_000).is_ok());
    }

    #[test]
    fn telemetry_gate_limits_routine_updates_but_allows_forced_events() {
        let mut gate = TelemetryGate::default();
        assert!(gate.should_publish(0, false));
        assert!(!gate.should_publish(20_000, false));
        assert!(gate.should_publish(40_000, true));
        assert!(!gate.should_publish(100_000, false));
        assert!(gate.should_publish(140_000, false));
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 7+8: Task orchestrator state machine
    // ────────────────────────────────────────────────────────────────────────

    fn sample_request(task_id: Uuid, intent: &str) -> TaskRequested {
        TaskRequested {
            task_id,
            intent: intent.to_owned(),
            context: None,
            deadline_ms: None,
            evidence_required: vec![EvidenceKind::Transcript, EvidenceKind::ToolCall],
            generation_id: None,
        }
    }

    #[test]
    fn admit_accepts_valid_task_and_returns_acknowledgement() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let ack = orchestrator
            .admit(sample_request(task_id, "Set a reminder"), Some("mock"), 1_000)
            .expect("valid task is admitted");
        assert_eq!(ack.task_id, task_id);
        assert_eq!(ack.status, TaskStatus::Queued);
        assert_eq!(ack.provider_id.as_deref(), Some("mock"));
        assert_eq!(ack.deadline_ms, 1_000 + DEFAULT_TASK_DEADLINE_MS);
        assert_eq!(orchestrator.active_count(), 1);
    }

    #[test]
    fn admit_rejects_empty_intent_and_duplicate_task_id() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let mut empty = sample_request(task_id, "   ");
        empty.intent = "   ".to_owned();
        assert!(orchestrator.admit(empty, None, 0).is_none());
        assert_eq!(orchestrator.active_count(), 0);

        let first = orchestrator
            .admit(sample_request(task_id, "Remind me"), None, 0)
            .expect("first admit");
        assert!(first.task_id == task_id);
        assert!(orchestrator
            .admit(sample_request(task_id, "Remind me again"), None, 0)
            .is_none());
        assert_eq!(orchestrator.active_count(), 1);
    }

    #[test]
    fn admit_warns_when_visual_evidence_requested_without_provider() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let mut request = sample_request(task_id, "Share a screenshot");
        request.evidence_required = vec![EvidenceKind::Visual];
        let ack = orchestrator
            .admit(request, None, 0)
            .expect("task without provider is still admitted");
        assert!(
            ack.warnings
                .iter()
                .any(|w| w.contains("visual evidence may be unavailable")),
            "acknowledgement should warn about visual evidence: {:?}",
            ack.warnings
        );
    }

    #[test]
    fn admit_binds_to_supplied_generation_id() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let generation_id = Uuid::new_v4();
        let mut request = sample_request(task_id, "Do this");
        request.generation_id = Some(generation_id);
        orchestrator.admit(request, Some("mock"), 0).expect("admit");
        // The task should be bound to the supplied generation, so completing
        // a different generation should NOT complete this task.
        let other_gen = Uuid::new_v4();
        let outcomes = orchestrator.complete_tasks_for_generation(other_gen);
        assert!(outcomes.is_empty());
        // Completing the bound generation should complete the task.
        let outcomes = orchestrator.complete_tasks_for_generation(generation_id);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].task_id, task_id);
        assert_eq!(outcomes[0].result, TaskResultKind::Success);
    }

    #[test]
    fn bind_pending_to_generation_attaches_unbound_tasks() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_a = Uuid::new_v4();
        let task_b = Uuid::new_v4();
        orchestrator
            .admit(sample_request(task_a, "Task A"), Some("mock"), 0)
            .expect("admit A");
        orchestrator
            .admit(sample_request(task_b, "Task B"), Some("mock"), 0)
            .expect("admit B");
        // Both tasks are unbound. Start a generation.
        let generation_id = Uuid::new_v4();
        let bound = orchestrator.bind_pending_to_generation(generation_id);
        assert_eq!(bound.len(), 2);
        // Completing a different generation should not complete either task.
        let other = Uuid::new_v4();
        assert!(orchestrator.complete_tasks_for_generation(other).is_empty());
        // Completing the bound generation completes both.
        let outcomes = orchestrator.complete_tasks_for_generation(generation_id);
        assert_eq!(outcomes.len(), 2);
        let completed_ids: Vec<Uuid> = outcomes.iter().map(|o| o.task_id).collect();
        assert!(completed_ids.contains(&task_a));
        assert!(completed_ids.contains(&task_b));
    }

    #[test]
    fn complete_tasks_for_generation_only_completes_bound_tasks() {
        // This is the core correctness fix: a finishing generation must NOT
        // complete tasks bound to a different (future) generation.
        let mut orchestrator = TaskOrchestrator::new();
        let gen_1 = Uuid::new_v4();
        let gen_2 = Uuid::new_v4();
        // Task A bound to gen_1.
        let mut req_a = sample_request(Uuid::new_v4(), "Task A");
        req_a.generation_id = Some(gen_1);
        orchestrator.admit(req_a, Some("mock"), 0).expect("admit A");
        // Task B bound to gen_2 (not yet started).
        let mut req_b = sample_request(Uuid::new_v4(), "Task B");
        req_b.generation_id = Some(gen_2);
        orchestrator.admit(req_b, Some("mock"), 0).expect("admit B");
        // gen_1 finishes: only Task A completes.
        let outcomes = orchestrator.complete_tasks_for_generation(gen_1);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].result, TaskResultKind::Success);
        assert_eq!(orchestrator.active_count(), 1, "Task B must remain active");
        // gen_2 finishes: Task B completes.
        let outcomes = orchestrator.complete_tasks_for_generation(gen_2);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(orchestrator.active_count(), 0);
    }

    #[test]
    fn expire_deadlines_emits_failure_outcome_for_elapsed_tasks() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let mut request = sample_request(task_id, "Slow task");
        request.deadline_ms = Some(5_000);
        orchestrator.admit(request, Some("mock"), 0).expect("admit");
        // Before the deadline: no outcomes.
        assert!(orchestrator.expire_deadlines(4_999).is_empty());
        assert_eq!(orchestrator.active_count(), 1);
        // At the deadline: the task expires.
        let outcomes = orchestrator.expire_deadlines(5_000);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].task_id, task_id);
        assert_eq!(outcomes[0].result, TaskResultKind::Failure);
        assert_eq!(outcomes[0].error_code.as_deref(), Some("DEADLINE_ELAPSED"));
        assert!(outcomes[0].summary.contains("Slow task"));
        assert!(outcomes[0].summary.contains("timed out"));
        assert_eq!(orchestrator.active_count(), 0);
        // A second expiry call is a no-op (task already resolved).
        assert!(orchestrator.expire_deadlines(10_000).is_empty());
    }

    #[test]
    fn cancel_task_emits_cancelled_outcome() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        orchestrator
            .admit(sample_request(task_id, "Remind me"), Some("mock"), 0)
            .expect("admit");
        let outcome = orchestrator
            .cancel_task(task_id, Some("user changed their mind"))
            .expect("cancel returns outcome for active task");
        assert_eq!(outcome.task_id, task_id);
        assert_eq!(outcome.result, TaskResultKind::Cancelled);
        assert_eq!(outcome.error_code.as_deref(), Some("CLIENT_CANCELLED"));
        assert!(outcome.summary.contains("Remind me"));
        assert!(outcome.summary.contains("cancelled"));
        assert_eq!(orchestrator.active_count(), 0);
        // Cancelling an already-resolved task returns None.
        assert!(orchestrator.cancel_task(task_id, None).is_none());
    }

    #[test]
    fn cancel_unknown_task_returns_none() {
        let mut orchestrator = TaskOrchestrator::new();
        assert!(orchestrator.cancel_task(Uuid::new_v4(), None).is_none());
    }

    #[test]
    fn mark_resolved_removes_active_record() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        orchestrator
            .admit(sample_request(task_id, "Do this"), Some("mock"), 0)
            .expect("admit");
        assert!(orchestrator.mark_resolved(task_id, TaskResultKind::Success));
        assert_eq!(orchestrator.active_count(), 0);
        // Second resolution is rejected.
        assert!(!orchestrator.mark_resolved(task_id, TaskResultKind::Success));
    }

    #[test]
    fn attach_evidence_is_idempotent() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        orchestrator
            .admit(sample_request(task_id, "Do this"), Some("mock"), 0)
            .expect("admit");
        let evidence_id = Uuid::new_v4();
        assert!(orchestrator.attach_evidence(task_id, EvidenceKind::Transcript, evidence_id));
        assert!(!orchestrator.attach_evidence(task_id, EvidenceKind::Transcript, evidence_id));
        assert!(orchestrator.attach_evidence(task_id, EvidenceKind::ToolCall, evidence_id));
        assert!(!orchestrator.attach_evidence(
            Uuid::new_v4(),
            EvidenceKind::Transcript,
            evidence_id
        ));
    }

    #[test]
    fn link_evidence_indexes_both_directions() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let evidence_id = Uuid::new_v4();
        let link = EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 0.92,
        };
        assert!(orchestrator.link_evidence(&link));
        assert!(!orchestrator.link_evidence(&link));
        let forward = orchestrator.evidence_for(task_id);
        assert_eq!(forward, vec![evidence_id]);
        let reverse = orchestrator.tasks_for_evidence(evidence_id);
        assert_eq!(reverse, vec![task_id]);
    }

    #[test]
    fn link_evidence_supports_multiple_proofs_per_task() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let proof_a = Uuid::new_v4();
        let proof_b = Uuid::new_v4();
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: proof_a,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 1.0,
        });
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: proof_b,
            link_type: EvidenceLinkType::TaskContext,
            confidence: 0.4,
        });
        let mut proofs = orchestrator.evidence_for(task_id);
        proofs.sort();
        let mut expected = vec![proof_a, proof_b];
        expected.sort();
        assert_eq!(proofs, expected);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 8: Evidence linking (5 tests)
    // ────────────────────────────────────────────────────────────────────────

    #[test]
    fn evidence_for_unknown_task_returns_empty_vec() {
        let orchestrator = TaskOrchestrator::new();
        assert!(orchestrator.evidence_for(Uuid::new_v4()).is_empty());
    }

    #[test]
    fn tasks_for_evidence_unknown_id_returns_empty_vec() {
        let orchestrator = TaskOrchestrator::new();
        assert!(orchestrator.tasks_for_evidence(Uuid::new_v4()).is_empty());
    }

    #[test]
    fn link_evidence_distinguishes_link_types_between_same_endpoints() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let evidence_id = Uuid::new_v4();
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 0.9,
        });
        assert!(orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskContext,
            confidence: 0.3,
        }));
        assert_eq!(orchestrator.evidence_for(task_id).len(), 2);
    }

    #[test]
    fn link_confidence_returns_strongest_link_between_endpoints() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let evidence_id = Uuid::new_v4();
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 0.42,
        });
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskContext,
            confidence: 0.85,
        });
        let confidence = orchestrator
            .link_confidence(task_id, evidence_id)
            .expect("link exists");
        assert!((confidence - 0.85).abs() < 1e-6, "should return the strongest link");
    }

    #[test]
    fn link_confidence_returns_none_for_unlinked_endpoints() {
        let orchestrator = TaskOrchestrator::new();
        assert!(orchestrator
            .link_confidence(Uuid::new_v4(), Uuid::new_v4())
            .is_none());
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 8: Resume deduplication (3 tests)
    // ────────────────────────────────────────────────────────────────────────

    #[test]
    fn buffer_outbound_deduplicates_by_event_id() {
        let mut orchestrator = TaskOrchestrator::new();
        let event_id = Uuid::new_v4();
        let json = r#"{"sequence":1}"#.to_owned();
        assert!(orchestrator.buffer_outbound(1, event_id, json.clone()));
        assert!(!orchestrator.buffer_outbound(2, event_id, json.clone()));
        assert_eq!(orchestrator.buffered_count(), 1);
    }

    #[test]
    fn replay_after_returns_only_events_above_threshold_in_order() {
        let mut orchestrator = TaskOrchestrator::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        orchestrator.buffer_outbound(10, a, r#"{"sequence":10,"id":"a"}"#.to_owned());
        orchestrator.buffer_outbound(20, b, r#"{"sequence":20,"id":"b"}"#.to_owned());
        orchestrator.buffer_outbound(30, c, r#"{"sequence":30,"id":"c"}"#.to_owned());
        let replay = orchestrator.replay_after(15);
        assert_eq!(replay.len(), 2);
        assert!(replay[0].contains("\"id\":\"b\""));
        assert!(replay[1].contains("\"id\":\"c\""));
    }

    #[test]
    fn replay_after_returns_empty_when_nothing_new() {
        let mut orchestrator = TaskOrchestrator::new();
        let a = Uuid::new_v4();
        orchestrator.buffer_outbound(5, a, r#"{"sequence":5}"#.to_owned());
        assert!(orchestrator.replay_after(5).is_empty());
        let mut empty = TaskOrchestrator::new();
        assert!(empty.replay_after(0).is_empty());
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 8: Outcome summary quality (2 tests)
    // ────────────────────────────────────────────────────────────────────────

    #[test]
    fn complete_tasks_for_generation_summary_cites_intent_and_evidence_kinds() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let generation_id = Uuid::new_v4();
        let mut request = sample_request(task_id, "Set a reminder for 3pm");
        request.generation_id = Some(generation_id);
        orchestrator.admit(request, Some("mock"), 0).expect("admit");
        // Attach some evidence.
        let evidence_id = Uuid::new_v4();
        orchestrator.attach_evidence(task_id, EvidenceKind::Transcript, evidence_id);
        orchestrator.link_evidence(&EvidenceLink {
            source_id: task_id,
            target_id: evidence_id,
            link_type: EvidenceLinkType::TaskProof,
            confidence: 1.0,
        });
        let outcomes = orchestrator.complete_tasks_for_generation(generation_id);
        assert_eq!(outcomes.len(), 1);
        let summary = &outcomes[0].summary;
        assert!(summary.contains("Set a reminder for 3pm"), "summary should cite intent: {summary}");
        assert!(summary.contains("1 evidence"), "summary should cite evidence count: {summary}");
        assert!(summary.contains("transcript"), "summary should cite evidence kind: {summary}");
        assert_eq!(outcomes[0].evidence_ids, vec![evidence_id]);
    }

    #[test]
    fn expire_deadlines_summary_cites_intent_and_deadline() {
        let mut orchestrator = TaskOrchestrator::new();
        let task_id = Uuid::new_v4();
        let mut request = sample_request(task_id, "Slow reminder");
        request.deadline_ms = Some(3_000);
        orchestrator.admit(request, Some("mock"), 0).expect("admit");
        let outcomes = orchestrator.expire_deadlines(3_000);
        assert_eq!(outcomes.len(), 1);
        let summary = &outcomes[0].summary;
        assert!(summary.contains("Slow reminder"), "summary should cite intent: {summary}");
        assert!(summary.contains("timed out"), "summary should cite timeout: {summary}");
        let detail = outcomes[0].error_detail.as_deref().unwrap_or("");
        assert!(detail.contains("3000"), "detail should cite deadline: {detail}");
    }
}
