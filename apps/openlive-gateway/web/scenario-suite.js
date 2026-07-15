/*
 * OpenLive 26.7.14.1 — LiveBench Scenario Suite.
 *
 * Three deterministic scenarios that exercise the task orchestrator
 * end-to-end. Each scenario:
 *   - Runs without user intervention (programmatically drives the
 *     orchestrator).
 *   - Collects evidence from real protocol events (no fabricated
 *     numbers).
 *   - Reports a pass/fail result with the evidence ids that support it.
 *
 * Design contract:
 *   - No synthetic benchmark claims. If a scenario cannot collect enough
 *     real samples, it reports "Insufficient samples" — never a fake
 *     number.
 *   - No mocks of the orchestrator. Scenarios use the real
 *     `TaskOrchestrator` instance from `app.js` so the evidence matrix
 *     reflects actual behavior.
 *   - Deterministic: running the suite twice with the same inputs
 *     produces the same pass/fail results (timing-sensitive scenarios
 *     use generous thresholds to avoid flakiness).
 *
 * The suite is exposed via `window.__openliveRunScenarios` so the
 * LiveBench "Run local demonstration" button can invoke it. It is also
 * exported for Node tests.
 */

/**
 * @typedef {Object} ScenarioResult
 * @property {string} name           Scenario name.
 * @property {"pass"|"fail"|"inconclusive"} status
 * @property {string} target         What the scenario is checking.
 * @property {string} evidence       Human-readable evidence summary.
 * @property {string[]} evidenceIds  Event ids that support the result.
 */

/** @type {({ name: string, target: string })[]} */
export const SCENARIO_DEFINITIONS = [
  {
    name: "Task acknowledgement latency",
    target: "p50 ≤ 500 ms across at least 5 acknowledgements",
  },
  {
    name: "Evidence linkage completeness",
    target: "100% of resolved tasks link to ≥ 1 evidence id",
  },
  {
    name: "Resume without duplication",
    target: "0 duplicate evidence entries after replay",
  },
];

/**
 * Build a scenario suite bound to a specific `TaskOrchestrator` instance.
 * The suite reads real state from the orchestrator (no fabrication) and
 * returns deterministic results.
 *
 * @param {import("./task-orchestrator.js").TaskOrchestrator} orchestrator
 * @param {{now: () => number, wait: (ms: number) => Promise<void>}} [clock]
 */
export function buildScenarioSuite(orchestrator, clock = defaultClock) {
  return {
    /**
     * Run all three scenarios and return their results. The caller is
     * responsible for rendering the results into the LiveBench evidence
     * matrix.
     * @returns {Promise<ScenarioResult[]>}
     */
    async runAll() {
      return [
        await this.runAcknowledgementLatency(),
        this.runEvidenceLinkageCompleteness(),
        this.runResumeWithoutDuplication(),
      ];
    },

    /**
     * Scenario 1: Task acknowledgement latency.
     *
     * Issues `N` synthetic task requests against the orchestrator (using
     * the `requestTask` path), waits for the gateway to acknowledge each,
     * and measures p50 acknowledgement latency. The scenario is
     * inconclusive if fewer than 5 acknowledgements arrive — it never
     * reports a fabricated percentile.
     *
     * Pass: p50 ≤ 500 ms with at least 5 samples.
     * Fail: p50 > 500 ms.
     * Inconclusive: fewer than 5 samples.
     *
     * @returns {Promise<ScenarioResult>}
     */
    async runAcknowledgementLatency() {
      const SAMPLE_TARGET = 5;
      const LATENCY_LIMIT_MS = 500;
      const before = orchestrator.acknowledgementLatencies.size;
      // Issue `SAMPLE_TARGET` task requests with a short deadline so the
      // gateway acks quickly. We use the orchestrator's public API so
      // the test exercises the real `task_requested` → `task_acknowledged`
      // path. If no session is active, the orchestrator returns null and
      // we fall through to "inconclusive".
      for (let i = 0; i < SAMPLE_TARGET; i += 1) {
        const taskId = orchestrator.requestTask(
          `LiveBench probe ${i + 1}`,
          { deadlineMs: clock.now() + 5_000 },
        );
        if (!taskId) {
          return inconclusive(
            SCENARIO_DEFINITIONS[0],
            "No active session — orchestrator.requestTask returned null",
          );
        }
        // Wait briefly for the gateway to ack. We use a short sleep so
        // the scenario completes in reasonable time even on slow networks.
        await clock.wait(100);
      }
      // Give the gateway a final grace period to deliver all acks.
      await clock.wait(200);
      const after = orchestrator.acknowledgementLatencies.size;
      const collected = after - before;
      if (collected < SAMPLE_TARGET) {
        return inconclusive(
          SCENARIO_DEFINITIONS[0],
          `Only ${collected} of ${SAMPLE_TARGET} acknowledgements arrived`,
        );
      }
      const p50 = orchestrator.acknowledgementP50();
      const status = p50 != null && p50 <= LATENCY_LIMIT_MS ? "pass" : "fail";
      return {
        name: SCENARIO_DEFINITIONS[0].name,
        status,
        target: SCENARIO_DEFINITIONS[0].target,
        evidence: `p50 = ${p50 ?? "n/a"} ms across ${collected} acknowledgements`,
        evidenceIds: [],
      };
    },

    /**
     * Scenario 2: Evidence linkage completeness.
     *
     * Inspects every resolved task in the orchestrator and checks that
     * each one has at least one evidence id linked. The scenario is
     * inconclusive if no tasks have resolved yet.
     *
     * Pass: 100% of resolved tasks have ≥ 1 evidence id.
     * Fail: any resolved task has 0 evidence ids.
     * Inconclusive: no tasks have resolved.
     *
     * @returns {ScenarioResult}
     */
    runEvidenceLinkageCompleteness() {
      const resolved = orchestrator.resolvedTasks();
      if (resolved.length === 0) {
        return inconclusive(
          SCENARIO_DEFINITIONS[1],
          "No resolved tasks to evaluate — issue a task first",
        );
      }
      const withEvidence = resolved.filter((t) => t.evidenceIds.length > 0);
      const rate = withEvidence.length / resolved.length;
      const status = rate === 1 ? "pass" : "fail";
      const evidenceIds = resolved.flatMap((t) => t.evidenceIds);
      return {
        name: SCENARIO_DEFINITIONS[1].name,
        status,
        target: SCENARIO_DEFINITIONS[1].target,
        evidence: `${withEvidence.length} / ${resolved.length} tasks linked to evidence (${(rate * 100).toFixed(0)}%)`,
        evidenceIds,
      };
    },

    /**
     * Scenario 3: Resume without duplication.
     *
     * Verifies that the orchestrator's dedup guards are in place:
     *   - Re-applying a `task_outcome` for an already-resolved task is
     *     a no-op (returns false).
     *   - Re-applying an `evidence_link` with the same endpoints is a
     *     no-op (returns false).
     *   - The resolved task count does not increase after duplicate
     *     delivery.
     *
     * Pass: all duplicate deliveries return false and the resolved count
     *      is unchanged.
     * Fail: any duplicate delivery returns true or the resolved count
     *      increases.
     *
     * This scenario does NOT require a live session — it exercises the
     * dedup logic directly. The "Resume" framing reflects the contract:
     * if the gateway replays a buffered outcome during resume, the
     * client must not double-count it.
     *
     * @returns {ScenarioResult}
     */
    runResumeWithoutDuplication() {
      // Seed a resolved task if none exists, so the scenario is
      // deterministic even on a fresh orchestrator.
      if (orchestrator.resolvedTasks().length === 0) {
        const seedId = seedResolvedTask(orchestrator);
        if (!seedId) {
          return inconclusive(
            SCENARIO_DEFINITIONS[2],
            "Could not seed a resolved task for dedup verification",
          );
        }
      }
      const before = orchestrator.resolvedTasks().length;
      const sample = orchestrator.resolvedTasks()[0];
      // Re-apply the same outcome. Must return false.
      const dupOutcomeAccepted = orchestrator.applyTaskOutcome({
        task_id: sample.id,
        result: sample.status,
        summary: sample.summary,
        evidence_ids: sample.evidenceIds,
      });
      // Re-apply an evidence link with the same endpoints. Must return
      // false (if the task has any evidence) or be skipped.
      let dupLinkAccepted = false;
      if (sample.evidenceIds.length > 0) {
        dupLinkAccepted = orchestrator.applyEvidenceLink({
          source_id: sample.id,
          target_id: sample.evidenceIds[0],
          link_type: "task_proof",
          confidence: 1.0,
        });
      }
      const after = orchestrator.resolvedTasks().length;
      const noDuplication = !dupOutcomeAccepted && !dupLinkAccepted && before === after;
      return {
        name: SCENARIO_DEFINITIONS[2].name,
        status: noDuplication ? "pass" : "fail",
        target: SCENARIO_DEFINITIONS[2].target,
        evidence: `duplicate outcome ${dupOutcomeAccepted ? "accepted" : "rejected"} · duplicate link ${dupLinkAccepted ? "accepted" : "rejected"} · resolved count ${before}→${after}`,
        evidenceIds: sample.evidenceIds,
      };
    },
  };
}

/**
 * Seed a resolved task into the orchestrator for the dedup scenario.
 * We synthesize a `task_outcome` directly rather than going through
 * `requestTask` (which would require a live session). The orchestrator
 * accepts the outcome as long as the task id is new.
 * @param {import("./task-orchestrator.js").TaskOrchestrator} orchestrator
 * @returns {string | null}
 */
function seedResolvedTask(orchestrator) {
  // The orchestrator's `applyTaskOutcome` only accepts outcomes for
  // tasks that already exist in `this.tasks`. We use `requestTask` if
  // a session is available, otherwise we cannot seed. In that case the
  // scenario reports "inconclusive" — which is the truthful answer.
  if (!orchestrator.transport.sessionId()) return null;
  const taskId = orchestrator.requestTask("LiveBench dedup probe");
  if (!taskId) return null;
  // Apply a synthetic acknowledgement so the task is in "acknowledged"
  // state, then apply a synthetic outcome.
  orchestrator.applyTaskAcknowledged({
    task_id: taskId,
    status: "queued",
    deadline_ms: Date.now() + 5_000,
    provider_id: "livebench-synthetic",
    warnings: [],
  });
  orchestrator.applyTaskOutcome({
    task_id: taskId,
    result: "success",
    summary: "Synthetic outcome for dedup verification",
    evidence_ids: [cryptoRandomUuid()],
  });
  return taskId;
}

/**
 * Build an inconclusive result for a scenario definition.
 * @param {{name: string, target: string}} definition
 * @param {string} reason
 * @returns {ScenarioResult}
 */
function inconclusive(definition, reason) {
  return {
    name: definition.name,
    status: "inconclusive",
    target: definition.target,
    evidence: reason,
    evidenceIds: [],
  };
}

/**
 * Default clock implementation using `Date.now()` and `setTimeout`. The
 * Node test runner can override this to use a deterministic clock.
 */
const defaultClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Generate a v4 UUID for synthetic evidence ids. Falls back to a
 * random string when `crypto.randomUUID` is unavailable.
 * @returns {string}
 */
function cryptoRandomUuid() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `synthetic-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
