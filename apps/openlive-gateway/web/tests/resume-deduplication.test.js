import assert from "node:assert/strict";
import test from "node:test";

import { TaskOrchestrator } from "../task-orchestrator.js";
import { buildScenarioSuite } from "../scenario-suite.js";

/* ---------------------------------------------------------------------------
   Phase 7: Resume deduplication — 3 deterministic tests
   --------------------------------------------------------------------------- */

/**
 * Build an orchestrator pre-seeded with one resolved task so the dedup
 * scenarios have something to verify against. The seed uses the
 * orchestrator's public API (no internal state mutation).
 */
function buildSeededOrchestrator() {
  let sequence = 0;
  const orchestrator = new TaskOrchestrator({
    send: () => {},
    sequence: () => (sequence += 1),
    sessionId: () => "test-session",
    mediaTimeUs: () => 0,
    protocolVersion: "1.0",
  });
  orchestrator.reset();
  const taskId = orchestrator.requestTask("Seed task");
  // Synthesize the acknowledgement + outcome so the task reaches a
  // resolved state. This mirrors what the gateway would do.
  orchestrator.applyTaskAcknowledged({
    task_id: taskId,
    status: "queued",
    deadline_ms: Date.now() + 30_000,
    provider_id: "mock",
    warnings: [],
  });
  orchestrator.applyTaskOutcome({
    task_id: taskId,
    result: "success",
    summary: "Seed outcome",
    evidence_ids: ["00000000-0000-4000-8000-000000000010"],
  });
  return orchestrator;
}

test("duplicate task_outcome for a resolved task is rejected and does not increase resolved count", () => {
  const orchestrator = buildSeededOrchestrator();
  const before = orchestrator.resolvedTasks().length;
  const sample = orchestrator.resolvedTasks()[0];
  // Re-apply the same outcome.
  const accepted = orchestrator.applyTaskOutcome({
    task_id: sample.id,
    result: sample.status,
    summary: sample.summary,
    evidence_ids: sample.evidenceIds,
  });
  assert.equal(accepted, false, "duplicate outcome must be rejected");
  const after = orchestrator.resolvedTasks().length;
  assert.equal(after, before, "resolved count must not increase");
  // The task's evidence ids must not be duplicated.
  const task = orchestrator.tasks.find((t) => t.id === sample.id);
  assert.equal(task.evidenceIds.length, 1);
});

test("duplicate evidence_link with the same endpoints is rejected and does not duplicate the index", () => {
  const orchestrator = buildSeededOrchestrator();
  const sample = orchestrator.resolvedTasks()[0];
  const evidenceId = sample.evidenceIds[0];
  // The seed already created a link via applyTaskOutcome. Re-apply it.
  const accepted = orchestrator.applyEvidenceLink({
    source_id: sample.id,
    target_id: evidenceId,
    link_type: "task_proof",
    confidence: 1.0,
  });
  assert.equal(accepted, false, "duplicate link must be rejected");
  // The reverse index must contain the task id exactly once.
  const indexed = orchestrator.evidenceIndex.get(evidenceId);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0], sample.id);
  // The task's evidenceIds must not be duplicated.
  const task = orchestrator.tasks.find((t) => t.id === sample.id);
  assert.equal(task.evidenceIds.length, 1);
});

test("scenario suite 'resume without duplication' passes against a seeded orchestrator", async () => {
  const orchestrator = buildSeededOrchestrator();
  const suite = buildScenarioSuite(orchestrator, {
    // Use a synchronous clock so the latency scenario doesn't actually
    // wait. The dedup scenario doesn't use the clock at all, so this is
    // just to keep the test fast.
    now: () => Date.now(),
    wait: async () => {},
  });
  // Run only the dedup scenario.
  const result = suite.runResumeWithoutDuplication();
  assert.equal(result.status, "pass");
  assert.match(result.evidence, /duplicate outcome rejected/);
  assert.match(result.evidence, /duplicate link rejected/);
  assert.match(result.evidence, /resolved count 1→1/);
});
