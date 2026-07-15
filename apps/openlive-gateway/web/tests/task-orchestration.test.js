import assert from "node:assert/strict";
import test from "node:test";

import { TaskOrchestrator, buildTaskRequestedPayload } from "../task-orchestrator.js";

/* ---------------------------------------------------------------------------
   Phase 7: Task orchestrator (browser side) — 4 deterministic tests
   --------------------------------------------------------------------------- */

/**
 * Build an orchestrator with a stub transport. The stub records every
 * envelope the orchestrator emits so tests can assert on the wire format
 * without a real WebSocket.
 */
function buildOrchestrator({ sessionId = "test-session" } = {}) {
  const sent = [];
  let sequence = 0;
  const orchestrator = new TaskOrchestrator({
    send: (envelope) => sent.push(envelope),
    sequence: () => (sequence += 1),
    sessionId: () => sessionId,
    mediaTimeUs: () => 0,
    protocolVersion: "1.0",
  });
  // Clear any state loaded from localStorage (Node test runner has none,
  // but `reset()` makes the test deterministic regardless of environment).
  orchestrator.reset();
  return { orchestrator, sent };
}

test("requestTask emits task_requested envelope and adds a pending entry", () => {
  const { orchestrator, sent } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Set a reminder for 3pm", {
    evidenceRequired: ["transcript", "tool_call"],
  });
  assert.ok(typeof taskId === "string" && taskId.length > 0);
  assert.equal(sent.length, 1);
  const envelope = sent[0];
  assert.equal(envelope.type, "task_requested");
  assert.equal(envelope.stream_id, "tasks");
  assert.equal(envelope.protocol_version, "1.0");
  assert.equal(envelope.payload.task_id, taskId);
  assert.equal(envelope.payload.intent, "Set a reminder for 3pm");
  assert.deepEqual(envelope.payload.evidence_required, ["transcript", "tool_call"]);
  // The orchestrator should have one pending entry.
  assert.equal(orchestrator.tasks.length, 1);
  assert.equal(orchestrator.tasks[0].status, "pending");
  assert.equal(orchestrator.activeTasks().length, 1);
  assert.equal(orchestrator.resolvedTasks().length, 0);
});

test("applyTaskAcknowledged transitions pending to acknowledged and records latency", () => {
  const { orchestrator } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Share a screenshot");
  // Simulate the gateway acknowledging 50 ms later.
  const ackPayload = {
    task_id: taskId,
    status: "queued",
    deadline_ms: Date.now() + 45_000,
    provider_id: "openlive/mock-duplex",
    warnings: ["visual context unavailable"],
  };
  const accepted = orchestrator.applyTaskAcknowledged(ackPayload);
  assert.equal(accepted, true);
  const task = orchestrator.tasks.find((t) => t.id === taskId);
  assert.equal(task.status, "acknowledged");
  assert.equal(task.providerId, "openlive/mock-duplex");
  assert.deepEqual(task.warnings, ["visual context unavailable"]);
  assert.equal(task.deadlineMs, ackPayload.deadline_ms);
  // Latency should be a non-negative number.
  const latency = orchestrator.acknowledgementLatencies.get(taskId);
  assert.ok(typeof latency === "number" && latency >= 0);
});

test("applyTaskOutcome transitions to final state and indexes evidence links", () => {
  const { orchestrator } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Remind me");
  orchestrator.applyTaskAcknowledged({
    task_id: taskId,
    status: "queued",
    deadline_ms: Date.now() + 30_000,
    provider_id: "mock",
    warnings: [],
  });
  const evidenceA = "00000000-0000-4000-8000-000000000001";
  const evidenceB = "00000000-0000-4000-8000-000000000002";
  const accepted = orchestrator.applyTaskOutcome({
    task_id: taskId,
    result: "success",
    summary: "Reminder set for 3:00 PM",
    evidence_ids: [evidenceA, evidenceB],
  });
  assert.equal(accepted, true);
  const task = orchestrator.tasks.find((t) => t.id === taskId);
  assert.equal(task.status, "success");
  assert.equal(task.summary, "Reminder set for 3:00 PM");
  assert.deepEqual(task.evidenceIds, [evidenceA, evidenceB]);
  // The evidence index should map both evidence ids back to the task.
  assert.deepEqual(orchestrator.evidenceIndex.get(evidenceA), [taskId]);
  assert.deepEqual(orchestrator.evidenceIndex.get(evidenceB), [taskId]);
  // Resolved task list should now include this task.
  assert.equal(orchestrator.resolvedTasks().length, 1);
  // Success rate should be 1.0 (one task, one success).
  assert.equal(orchestrator.successRate(), 1);
  // Evidence linkage rate should be 1.0 (the task has evidence ids).
  assert.equal(orchestrator.evidenceLinkageRate(), 1);
});

test("applyEvidenceLink records bidirectional links and deduplicates", () => {
  const { orchestrator } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Do this");
  const evidenceId = "00000000-0000-4000-8000-000000000003";
  // Apply the same link twice.
  const first = orchestrator.applyEvidenceLink({
    source_id: taskId,
    target_id: evidenceId,
    link_type: "task_proof",
    confidence: 0.9,
  });
  const second = orchestrator.applyEvidenceLink({
    source_id: taskId,
    target_id: evidenceId,
    link_type: "task_proof",
    confidence: 0.9,
  });
  assert.equal(first, true);
  assert.equal(second, false, "duplicate link must be rejected");
  // The task's evidenceIds should contain the evidence id exactly once.
  const task = orchestrator.tasks.find((t) => t.id === taskId);
  assert.deepEqual(task.evidenceIds, [evidenceId]);
  // The reverse index should map the evidence id back to the task.
  assert.deepEqual(orchestrator.evidenceIndex.get(evidenceId), [taskId]);
});

test("buildTaskRequestedPayload rejects empty intent and omits optional fields", () => {
  // Empty intent must throw — the orchestrator never sends a task with no
  // intent.
  assert.throws(() => buildTaskRequestedPayload(""), /non-empty/);
  assert.throws(() => buildTaskRequestedPayload("   "), /non-empty/);
  // Optional fields are omitted when not supplied.
  const minimal = buildTaskRequestedPayload("Do this");
  assert.equal(minimal.intent, "Do this");
  assert.equal("context" in minimal, false);
  assert.equal("deadline_ms" in minimal, false);
  assert.equal("evidence_required" in minimal, false);
  // All optional fields are included when supplied.
  const full = buildTaskRequestedPayload("Do this", {
    context: "In the meeting",
    deadlineMs: 5_000,
    evidenceRequired: ["transcript"],
  });
  assert.equal(full.context, "In the meeting");
  assert.equal(full.deadline_ms, 5_000);
  assert.deepEqual(full.evidence_required, ["transcript"]);
});

test("cancelTask emits task_cancel envelope for pending tasks", () => {
  const { orchestrator, sent } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Remind me");
  assert.equal(sent.length, 1); // task_requested
  const cancelled = orchestrator.cancelTask(taskId, "changed my mind");
  assert.equal(cancelled, true);
  assert.equal(sent.length, 2); // task_requested + task_cancel
  const cancelEnvelope = sent[1];
  assert.equal(cancelEnvelope.type, "task_cancel");
  assert.equal(cancelEnvelope.stream_id, "tasks");
  assert.equal(cancelEnvelope.payload.task_id, taskId);
  assert.equal(cancelEnvelope.payload.reason, "changed my mind");
});

test("cancelTask rejects already-resolved tasks", () => {
  const { orchestrator, sent } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Do this");
  // Resolve the task via an outcome.
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
    summary: "Done",
    evidence_ids: [],
  });
  const sentBefore = sent.length;
  // Cancel should be rejected — the task is already resolved.
  const cancelled = orchestrator.cancelTask(taskId);
  assert.equal(cancelled, false);
  assert.equal(sent.length, sentBefore, "no cancel envelope should be sent");
});

test("applyTaskAcknowledged rejects unknown status values", () => {
  const { orchestrator } = buildOrchestrator();
  const taskId = orchestrator.requestTask("Do this");
  // Send an acknowledgement with an invalid status.
  const accepted = orchestrator.applyTaskAcknowledged({
    task_id: taskId,
    status: "bogus", // not a valid TaskStatus
    deadline_ms: Date.now() + 30_000,
    provider_id: "mock",
    warnings: [],
  });
  assert.equal(accepted, false, "invalid status must be rejected");
  // The task should remain pending.
  const task = orchestrator.tasks.find((t) => t.id === taskId);
  assert.equal(task.status, "pending");
});
