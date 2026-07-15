/*
 * OpenLive 26.7.14.1 — Task Orchestrator (browser side).
 *
 * Mirrors the gateway TaskOrchestrator contract:
 *   - requestTask(intent, options) → emits a `task_requested` envelope via
 *     the provided `send` callback and adds a pending entry to the local
 *     task list.
 *   - applyTaskAcknowledged(payload) → marks the pending entry as
 *     acknowledged with the negotiated deadline and warnings.
 *   - applyTaskOutcome(payload) → marks the entry as resolved with the
 *     outcome summary, evidence ids, and any error.
 *   - applyEvidenceLink(payload) → records a bidirectional link so the
 *     UI can answer "which task does this evidence support?".
 *
 * Design contract (matches Phase 6 principles):
 *   - No fabricated state. A task is never shown as "Acknowledged" unless
 *     the gateway actually said so via `task_acknowledged`.
 *   - No synthetic benchmark claims. The scenario suite never invents
 *     latency numbers; it only measures real `task_requested` →
 *     `task_acknowledged` round-trips.
 *   - Append-only ledger. Task outcomes are never overwritten; a duplicate
 *     `task_outcome` for the same `task_id` is dropped with a debug log.
 *   - Resume-aware. The orchestrator persists task state to localStorage
 *     keyed by session id so a reconnected client can rebuild the rail
 *     without losing pending entries.
 *
 * The module is DOM-aware but degrades gracefully when `document` is
 * undefined (Node test runner). All DOM writes go through `$` / `$$`
 * helpers that no-op when the document is missing.
 */

const STORAGE_KEY = "openlive:v2:tasks";
const DEFAULT_DEADLINE_MS = 45_000;

/**
 * @typedef {Object} TaskEntry
 * @property {string} id              UUID, generated client-side.
 * @property {string} intent          The user-supplied "do this" string.
 * @property {"pending"|"acknowledged"|"success"|"failure"|"cancelled"} status
 * @property {number}  createdAtMs    epoch millis
 * @property {number?} deadlineMs     epoch millis, set on acknowledgement
 * @property {string?} providerId     provider that accepted the task
 * @property {string[]} warnings      gateway warnings (e.g. visual context unavailable)
 * @property {string?} summary        outcome summary, set on completion
 * @property {string[]} evidenceIds   ids of evidence events linked to this task
 * @property {string?} errorCode      set when status === "failure"
 * @property {string?} errorDetail    human-readable failure detail
 * @property {number?} acknowledgedAtMs  epoch millis, set on acknowledgement
 * @property {number?} resolvedAtMs   epoch millis, set on completion
 */

/** @returns {TaskEntry} */
function newTask(id, intent, createdAtMs) {
  return {
    id,
    intent,
    status: "pending",
    createdAtMs,
    deadlineMs: null,
    providerId: null,
    warnings: [],
    summary: null,
    evidenceIds: [],
    errorCode: null,
    errorDetail: null,
    acknowledgedAtMs: null,
    resolvedAtMs: null,
  };
}

/**
 * @param {string} selector
 * @returns {Element | null}
 */
function $(selector) {
  if (typeof document === "undefined") return null;
  return document.querySelector(selector);
}

/**
 * Build a `task_requested` payload matching the protocol struct.
 * @param {string} intent
 * @param {{context?: string, deadlineMs?: number, evidenceRequired?: string[]}} [options]
 * @returns {{task_id: string, intent: string, context?: string, deadline_ms?: number, evidence_required?: string[]}}
 */
export function buildTaskRequestedPayload(intent, options = {}) {
  if (typeof intent !== "string" || intent.trim().length === 0) {
    throw new Error("task intent must be a non-empty string");
  }
  const payload = {
    task_id: cryptoRandomUuid(),
    intent,
  };
  if (options.context) payload.context = options.context;
  if (typeof options.deadlineMs === "number") {
    payload.deadline_ms = options.deadlineMs;
  }
  if (Array.isArray(options.evidenceRequired) && options.evidenceRequired.length > 0) {
    payload.evidence_required = options.evidenceRequired;
  }
  return payload;
}

/**
 * Generate a v4 UUID. Uses `globalThis.crypto.randomUUID` when available
 * (browsers + Node 19+), falls back to a RFC4122-v4-shaped string for
 * older runtimes. The fallback is only used in tests; production browsers
 * always have `crypto.randomUUID`.
 * @returns {string}
 */
function cryptoRandomUuid() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  // RFC4122 v4 fallback (test-only). Not cryptographically strong.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/**
 * Browser-side task orchestrator. Owns the in-memory task list, the
 * bidirectional evidence link index, and the localStorage persistence
 * layer. The orchestrator never sends protocol messages itself — it
 * returns payloads that the caller (`app.js`) emits on the wire.
 */
export class TaskOrchestrator {
  /**
   * @param {{send: (envelope: object) => void, sequence: () => number, sessionId: () => string | undefined, mediaTimeUs: () => number, protocolVersion: string}} transport
   */
  constructor(transport) {
    this.transport = transport;
    /** @type {TaskEntry[]} */
    this.tasks = [];
    /** @type {Map<string, string[]>} evidence_id → task_ids that cited it */
    this.evidenceIndex = new Map();
    /** @type {Set<string>} task_ids we have already resolved (dedup guard) */
    this.resolvedTaskIds = new Set();
    /** @type {Map<string, number>} task_id → acknowledgement latency in ms */
    this.acknowledgementLatencies = new Map();
    /** Pending `task_id` → `createdAtMs` so we can measure latency when the ack arrives. */
    this.pendingSentAt = new Map();
    this.loadFromStorage();
  }

  /**
   * Build and emit a `task_requested` envelope. Returns the task id so
   * the caller can correlate it with the eventual acknowledgement.
   * @param {string} intent
   * @param {{context?: string, deadlineMs?: number, evidenceRequired?: string[]}} [options]
   * @returns {string | null} task_id, or null if no session is active
   */
  requestTask(intent, options = {}) {
    if (!this.transport.sessionId()) return null;
    const payload = buildTaskRequestedPayload(intent, options);
    const taskId = payload.task_id;
    const entry = newTask(taskId, intent, Date.now());
    this.tasks.unshift(entry);
    this.pendingSentAt.set(taskId, entry.createdAtMs);
    this.trim();
    this.persist();
    this.render();
    this.transport.send({
      protocol_version: this.transport.protocolVersion,
      event_id: cryptoRandomUuid(),
      session_id: this.transport.sessionId(),
      stream_id: "tasks",
      sequence: this.transport.sequence(),
      media_time_us: this.transport.mediaTimeUs(),
      type: "task_requested",
      payload,
    });
    this.dispatchLocalEvent("openlive:task-requested", { taskId, intent });
    return taskId;
  }

  /**
   * Cancel a pending or acknowledged task. Emits a `task_cancel` envelope
   * on the wire. The gateway responds with a `task_outcome` whose
   * `result` is `cancelled`; this method does NOT immediately mark the
   * task as cancelled — it waits for the gateway's outcome so the client
   * ledger stays consistent with the gateway's. Returns true if a cancel
   * was sent, false if the task was already resolved or unknown.
   * @param {string} taskId
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancelTask(taskId, reason) {
    if (!this.transport.sessionId()) return false;
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    if (!["pending", "acknowledged"].includes(task.status)) return false;
    const payload = { task_id: taskId };
    if (reason) payload.reason = reason;
    this.transport.send({
      protocol_version: this.transport.protocolVersion,
      event_id: cryptoRandomUuid(),
      session_id: this.transport.sessionId(),
      stream_id: "tasks",
      sequence: this.transport.sequence(),
      media_time_us: this.transport.mediaTimeUs(),
      type: "task_cancel",
      payload,
    });
    this.dispatchLocalEvent("openlive:task-cancel-requested", { taskId });
    return true;
  }

  /**
   * Apply a `task_acknowledged` payload from the gateway. Updates the
   * matching task entry, records acknowledgement latency, and re-renders.
   * Validates the `status` field — only `queued`, `in_progress`, and
   * `blocked` are accepted. Returns true if a matching pending task was
   * found and the acknowledgement was well-formed.
   * @param {object} payload
   * @returns {boolean}
   */
  applyTaskAcknowledged(payload) {
    const task = this.tasks.find((t) => t.id === payload.task_id);
    if (!task) return false;
    if (task.status !== "pending") {
      // Duplicate ack — drop silently to keep the ledger append-only.
      return false;
    }
    // Validate the status field — the gateway must send one of the
    // canonical TaskStatus values. An unknown status is rejected rather
    // than silently accepted.
    const validStatuses = ["queued", "in_progress", "blocked"];
    if (!validStatuses.includes(payload.status)) {
      return false;
    }
    task.status = "acknowledged";
    task.acknowledgedAtMs = Date.now();
    task.deadlineMs = payload.deadline_ms ?? task.acknowledgedAtMs + DEFAULT_DEADLINE_MS;
    task.providerId = payload.provider_id ?? null;
    task.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    const sentAt = this.pendingSentAt.get(task.id);
    if (typeof sentAt === "number") {
      this.acknowledgementLatencies.set(task.id, task.acknowledgedAtMs - sentAt);
      this.pendingSentAt.delete(task.id);
    }
    this.persist();
    this.render();
    this.dispatchLocalEvent("openlive:task-acknowledged", {
      taskId: task.id,
      deadlineMs: task.deadlineMs,
      latencyMs: this.acknowledgementLatencies.get(task.id) ?? null,
    });
    return true;
  }

  /**
   * Apply a `task_outcome` payload. Updates the matching task entry and
   * emits a local event so the evidence ledger can record the outcome.
   * Duplicate outcomes for the same `task_id` are dropped.
   * @param {object} payload
   * @returns {boolean}
   */
  applyTaskOutcome(payload) {
    if (this.resolvedTaskIds.has(payload.task_id)) {
      // Duplicate outcome — keep the ledger append-only without dupes.
      return false;
    }
    const task = this.tasks.find((t) => t.id === payload.task_id);
    if (!task) return false;
    const result = payload.result;
    if (!["success", "failure", "cancelled"].includes(result)) {
      return false;
    }
    task.status = result;
    task.summary = payload.summary ?? "";
    task.evidenceIds = Array.isArray(payload.evidence_ids) ? payload.evidence_ids : [];
    task.errorCode = payload.error_code ?? null;
    task.errorDetail = payload.error_detail ?? null;
    task.resolvedAtMs = Date.now();
    this.resolvedTaskIds.add(task.id);
    // Index evidence links in the reverse direction so the UI can answer
    // "which task does this evidence support?".
    for (const evidenceId of task.evidenceIds) {
      const list = this.evidenceIndex.get(evidenceId) ?? [];
      if (!list.includes(task.id)) list.push(task.id);
      this.evidenceIndex.set(evidenceId, list);
    }
    this.persist();
    this.render();
    this.dispatchLocalEvent("openlive:task-outcome", {
      taskId: task.id,
      result: task.status,
      summary: task.summary,
      evidenceIds: task.evidenceIds,
    });
    return true;
  }

  /**
   * Apply an `evidence_link` payload. Records the bidirectional link so
   * the evidence matrix can render the relationship. Duplicate links are
   * dropped.
   * @param {object} payload
   * @returns {boolean}
   */
  applyEvidenceLink(payload) {
    const sourceId = payload.source_id;
    const targetId = payload.target_id;
    if (!sourceId || !targetId) return false;
    const list = this.evidenceIndex.get(targetId) ?? [];
    if (list.includes(sourceId)) return false;
    list.push(sourceId);
    this.evidenceIndex.set(targetId, list);
    // If the source is a known task, also push the target onto its
    // evidence ids list (deduplicated).
    const task = this.tasks.find((t) => t.id === sourceId);
    if (task && !task.evidenceIds.includes(targetId)) {
      task.evidenceIds.push(targetId);
    }
    this.render();
    return true;
  }

  /**
   * Tasks that are still pending or acknowledged (not yet resolved).
   * @returns {TaskEntry[]}
   */
  activeTasks() {
    return this.tasks.filter((t) => t.status === "pending" || t.status === "acknowledged");
  }

  /**
   * Tasks that have reached a final state.
   * @returns {TaskEntry[]}
   */
  resolvedTasks() {
    return this.tasks.filter((t) =>
      ["success", "failure", "cancelled"].includes(t.status),
    );
  }

  /**
   * p50 acknowledgement latency in millis, or null if no acks yet.
   * Used by the LiveBench scenario suite.
   * @returns {number | null}
   */
  acknowledgementP50() {
    const samples = [...this.acknowledgementLatencies.values()].sort((a, b) => a - b);
    if (samples.length === 0) return null;
    return samples[Math.floor(samples.length / 2)];
  }

  /**
   * p95 acknowledgement latency in millis, or null if fewer than 20 samples
   * (p95 is not meaningful with too few samples).
   * @returns {number | null}
   */
  acknowledgementP95() {
    const samples = [...this.acknowledgementLatencies.values()].sort((a, b) => a - b);
    if (samples.length < 20) return null;
    const idx = Math.min(samples.length - 1, Math.floor(samples.length * 0.95));
    return samples[idx];
  }

  /**
   * Fraction of resolved tasks that succeeded. Used by the evidence
   * matrix. Returns null if no tasks have resolved.
   * @returns {number | null}
   */
  successRate() {
    const resolved = this.resolvedTasks();
    if (resolved.length === 0) return null;
    const successes = resolved.filter((t) => t.status === "success").length;
    return successes / resolved.length;
  }

  /**
   * Fraction of resolved tasks that have at least one evidence id linked.
   * Used by the LiveBench "evidence linkage completeness" scenario.
   * Returns null if no tasks have resolved.
   * @returns {number | null}
   */
  evidenceLinkageRate() {
    const resolved = this.resolvedTasks();
    if (resolved.length === 0) return null;
    const withEvidence = resolved.filter((t) => t.evidenceIds.length > 0).length;
    return withEvidence / resolved.length;
  }

  /**
   * Render the task rail. No-ops when the DOM is unavailable (Node tests).
   */
  render() {
    const rail = $("#taskRail");
    if (!rail) return;
    if (this.tasks.length === 0) {
      rail.innerHTML = `<div class="rail-empty"><span><svg viewBox="0 0 24 24"><use href="#icon-task" /></svg></span><strong>Nothing delegated yet</strong><p>Ask OpenLive to research, compare, or prepare something while you keep talking.</p></div>`;
      return;
    }
    rail.innerHTML = this.tasks.map((task) => this.renderTask(task)).join("");
    const count = $("#taskCount");
    if (count) count.textContent = String(this.tasks.length);
    // Wire cancel buttons. Each button carries the task id in
    // `data-task-id` so we can dispatch without closures.
    rail.querySelectorAll(".task-cancel").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const taskId = button.dataset.taskId;
        if (taskId) this.cancelTask(taskId);
      });
    });
  }

  /**
   * Render a single task entry as HTML.
   * @param {TaskEntry} task
   * @returns {string}
   */
  renderTask(task) {
    const statusGlyph = {
      pending: "⏳",
      acknowledged: "✓",
      success: "✓",
      failure: "✕",
      cancelled: "—",
    }[task.status] ?? "?";
    const statusLabel = {
      pending: "Waiting for acknowledgement",
      acknowledged: `Acknowledged · ${this.formatDeadline(task.deadlineMs)}`,
      success: "Completed",
      failure: `Failed${task.errorCode ? ` · ${task.errorCode}` : ""}`,
      cancelled: "Cancelled",
    }[task.status] ?? task.status;
    const evidenceBadge =
      task.evidenceIds.length > 0
        ? `<span class="task-evidence">${task.evidenceIds.length} evidence</span>`
        : "";
    const warnings =
      task.warnings.length > 0
        ? `<small class="task-warnings">${escapeHtml(task.warnings.join("; "))}</small>`
        : "";
    // Show a cancel button only for tasks that are still cancellable
    // (pending or acknowledged). Resolved tasks show no action.
    const cancelButton =
      task.status === "pending" || task.status === "acknowledged"
        ? `<button class="task-cancel" data-task-id="${task.id}" type="button" aria-label="Cancel task">Cancel</button>`
        : "";
    return `<article class="task-item task-${task.status}" data-task-id="${task.id}">
      <header><strong>${escapeHtml(task.intent)}</strong><span class="task-status" aria-label="${escapeHtml(statusLabel)}">${statusGlyph}</span></header>
      <small>${escapeHtml(statusLabel)}</small>
      ${task.summary ? `<p class="task-summary">${escapeHtml(task.summary)}</p>` : ""}
      ${warnings}
      <div class="task-actions">${evidenceBadge}${cancelButton}</div>
    </article>`;
  }

  /**
   * Format a deadline as a relative time string.
   * @param {number | null} deadlineMs
   * @returns {string}
   */
  formatDeadline(deadlineMs) {
    if (typeof deadlineMs !== "number") return "no deadline";
    const delta = deadlineMs - Date.now();
    if (delta <= 0) return "deadline elapsed";
    const seconds = Math.round(delta / 1000);
    if (seconds < 60) return `${seconds}s deadline`;
    return `${Math.round(seconds / 60)}m deadline`;
  }

  /**
   * Trim the in-memory task list to avoid unbounded growth. Keeps the
   * most recent 50 entries.
   */
  trim() {
    if (this.tasks.length > 50) {
      this.tasks.length = 50;
    }
  }

  /**
   * Persist the task list to localStorage so a reconnected client can
   * rebuild the rail. No-ops when localStorage is unavailable.
   */
  persist() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tasks));
    } catch {
      // Quota exceeded or storage disabled — degrade silently. The
      // orchestrator remains correct in-memory; only resume persistence
      // is affected.
    }
  }

  /**
   * Load the task list from localStorage. No-ops when localStorage is
   * unavailable.
   */
  loadFromStorage() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.tasks = parsed.filter((t) => t && typeof t.id === "string");
        for (const task of this.tasks) {
          if (["success", "failure", "cancelled"].includes(task.status)) {
            this.resolvedTaskIds.add(task.id);
            for (const evidenceId of task.evidenceIds ?? []) {
              const list = this.evidenceIndex.get(evidenceId) ?? [];
              if (!list.includes(task.id)) list.push(task.id);
              this.evidenceIndex.set(evidenceId, list);
            }
          }
        }
      }
    } catch {
      // Corrupt storage — start fresh.
      this.tasks = [];
    }
  }

  /**
   * Clear all task state. Used by the LiveBench scenario suite to start
   * a clean run.
   */
  reset() {
    this.tasks = [];
    this.evidenceIndex.clear();
    this.resolvedTaskIds.clear();
    this.acknowledgementLatencies.clear();
    this.pendingSentAt.clear();
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    this.render();
  }

  /**
   * Dispatch a CustomEvent on window. No-ops when window is unavailable.
   * @param {string} name
   * @param {object} detail
   */
  dispatchLocalEvent(name, detail) {
    if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/**
 * Escape HTML special characters in a string so task intent / summary
 * text is never interpreted as markup. Exported so other modules
 * (live-desk.js) can reuse the same implementation.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
