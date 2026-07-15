/*
 * OpenLive 26.7.14.1 — Signal Desk shell controller.
 * Design contract: operator-console clarity, truthful state, explicit consent,
 * and no synthetic benchmark claims. This module never starts media capture.
 */

import { buildScenarioSuite, SCENARIO_DEFINITIONS } from "./scenario-suite.js";
import { escapeHtml } from "./task-orchestrator.js";

const MEMORY_KEY = "openlive:v2:memory-scope";
const LANGUAGE_KEY = "openlive:v2:language";
const LANGUAGE_OPTIONS = [
  { id: "auto", label: "Auto · EN" },
  { id: "en", label: "English · EN" },
  { id: "es", label: "Español · ES" },
  { id: "fr", label: "Français · FR" },
  { id: "de", label: "Deutsch · DE" },
  { id: "ja", label: "日本語 · JA" },
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function emitEvidence(title, detail, tone = "cyan") {
  window.dispatchEvent(
    new CustomEvent("openlive:evidence", { detail: { title, detail, tone } }),
  );
}

function emitNotice(message) {
  window.dispatchEvent(new CustomEvent("openlive:notice", { detail: { message } }));
}

function setWorkspace(target) {
  const isBench = target === "bench";
  $(".app-shell")?.toggleAttribute("hidden", isBench);
  $("#benchWorkspace")?.toggleAttribute("hidden", !isBench);
  $$("[data-workspace-target]").forEach((button) => {
    const active = button.dataset.workspaceTarget === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.body.dataset.workspace = target;
  if (isBench) $("#benchWorkspace")?.focus({ preventScroll: true });
}

function initializeWorkspace() {
  $$("[data-workspace-target]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.classList.contains("active")));
    button.addEventListener("click", () => setWorkspace(button.dataset.workspaceTarget));
  });
  $("#liveBenchControl")?.addEventListener("click", () => setWorkspace("bench"));
  $(".brand-lockup")?.addEventListener("click", () => setWorkspace("live"));
}

function setMemoryScope(scope, announce = false) {
  const safeScope = scope === "session" ? "session" : "off";
  localStorage.setItem(MEMORY_KEY, safeScope);
  const badge = $("#memoryBadge");
  const label = $("#memoryScopeLabel");
  const control = $("#memoryControl");
  if (badge) badge.textContent = safeScope === "session" ? "Session" : "Off";
  if (label) label.textContent = safeScope === "session" ? "Session memory" : "Memory off";
  control?.setAttribute("aria-pressed", String(safeScope === "session"));
  control?.setAttribute(
    "aria-label",
    safeScope === "session"
      ? "Disable session-scoped memory"
      : "Enable memory for this session only",
  );
  window.dispatchEvent(
    new CustomEvent("openlive:memory-scope", { detail: { scope: safeScope } }),
  );
  if (announce) {
    emitEvidence(
      "Memory scope changed",
      safeScope === "session"
        ? "Session only · durable retention remains off"
        : "Memory off · no conversation context requested for retention",
      safeScope === "session" ? "green" : "cyan",
    );
  }
}

function initializeMemory() {
  setMemoryScope(localStorage.getItem(MEMORY_KEY) ?? "off");
  $("#memoryControl")?.addEventListener("click", () => {
    const next = localStorage.getItem(MEMORY_KEY) === "session" ? "off" : "session";
    setMemoryScope(next, true);
  });
}

function setLanguage(id, announce = false) {
  const option = LANGUAGE_OPTIONS.find((entry) => entry.id === id) ?? LANGUAGE_OPTIONS[0];
  localStorage.setItem(LANGUAGE_KEY, option.id);
  const value = $("#languageValue");
  if (value) value.textContent = option.label;
  $("#languageControl")?.setAttribute("aria-label", `Language mode: ${option.label}`);
  window.dispatchEvent(
    new CustomEvent("openlive:language", { detail: { language: option.id } }),
  );
  if (announce) emitEvidence("Language preference changed", option.label, "cyan");
}

function initializeLanguage() {
  setLanguage(localStorage.getItem(LANGUAGE_KEY) ?? "auto");
  $("#languageControl")?.addEventListener("click", () => {
    const current = localStorage.getItem(LANGUAGE_KEY) ?? "auto";
    const index = LANGUAGE_OPTIONS.findIndex((entry) => entry.id === current);
    setLanguage(LANGUAGE_OPTIONS[(index + 1) % LANGUAGE_OPTIONS.length].id, true);
  });
}

function focusSection(selector) {
  const section = $(selector);
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  section.classList.remove("attention-pulse");
  void section.offsetWidth;
  section.classList.add("attention-pulse");
}

function initializeRail() {
  $("#tasksControl")?.addEventListener("click", () => focusSection(".tasks-section"));
  $("#evidenceControl")?.addEventListener("click", () => focusSection(".evidence-section"));
  $("#taskExpand")?.addEventListener("click", () => focusSection(".tasks-section"));
  $("#evidenceExpand")?.addEventListener("click", () => focusSection(".evidence-section"));
  $("#privacyControl")?.addEventListener("click", () => {
    emitNotice(
      "Privacy posture: microphone and previews are permission-gated; frames leave the browser only after Share one frame; durable memory is off.",
    );
    emitEvidence("Privacy controls inspected", "No setting was changed", "cyan");
  });
}

function evidenceRows() {
  return $$("#evidenceFeed > li").map((item, index) => {
    const title = item.querySelector("strong")?.textContent?.trim() ?? "Evidence event";
    const detail = item.querySelector("p")?.textContent?.trim() ?? "";
    const timestamp = item.querySelector("time")?.dateTime || new Date().toISOString();
    return {
      schema: "openlive.evidence.v2",
      sequence: index + 1,
      timestamp,
      title,
      detail: detail.replace(/data:[^\s]+/gi, "[redacted-data-url]"),
      redaction: "client-safe",
    };
  });
}

function initializeEvidenceExport() {
  $("#exportEvidence")?.addEventListener("click", () => {
    const rows = evidenceRows();
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openlive-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    emitEvidence("Evidence exported", `${rows.length} redacted JSONL records`, "green");
  });
}

function runUiIntegrityCheck() {
  const checks = [
    ["camera-control-label", Boolean($("#camera")?.getAttribute("aria-label"))],
    ["screen-control-label", Boolean($("#screenShare")?.getAttribute("aria-label"))],
    ["local-preview-copy", $("#captureEmpty")?.textContent.includes("stay local")],
    ["snapshot-explicit-action", $("#snapshotAction")?.textContent.includes("Share one frame")],
    ["memory-control", Boolean($("#memoryControl")?.getAttribute("aria-pressed"))],
    ["evidence-export", Boolean($("#exportEvidence"))],
    ["task-rail-present", Boolean($("#taskRail"))],
    ["task-add-button", Boolean($("#taskAdd"))],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  const button = $("#runBenchDemo");
  if (failed.length === 0) {
    if (button) button.textContent = "UI integrity check passed";
    emitEvidence("UI integrity check passed", `${checks.length} deterministic interface assertions`, "green");
  } else {
    if (button) button.textContent = "UI integrity check failed";
    emitEvidence("UI integrity check failed", failed.join(", "), "yellow");
  }
  return failed.length === 0;
}

/**
 * Phase 7: render the scenario suite results into the LiveBench evidence
 * matrix. Each scenario gets a row with its name, target, status, and
 * evidence summary.
 * @param {Array<{name: string, status: string, target: string, evidence: string, evidenceIds: string[]}>} results
 */
function renderScenarioResults(results) {
  const container = $("#scenarioMatrix");
  if (!container) return;
  const rows = results.map((result) => {
    const statusClass =
      result.status === "pass" ? "ready" :
      result.status === "fail" ? "pending" :
      "pending";
    const statusLabel =
      result.status === "pass" ? "Pass" :
      result.status === "fail" ? "Fail" :
      "Inconclusive";
    return `<div class="scenario-row">
      <span>${escapeHtml(result.name)}</span>
      <span>${escapeHtml(result.evidence)}</span>
      <span>${escapeHtml(result.target)}</span>
      <strong class="${statusClass}">${statusLabel}</strong>
    </div>`;
  }).join("");
  container.innerHTML = `<div class="scenario-row heading"><span>Scenario</span><span>Evidence</span><span>Target</span><span>Status</span></div>${rows}`;
}

/**
 * Phase 7: run the full LiveBench demonstration. This combines the UI
 * integrity check (deterministic DOM assertions) with the scenario suite
 * (deterministic protocol-level assertions). The scenario suite is
 * instantiated lazily via `window.__openliveTaskOrchestrator` so we can
 * reach the real orchestrator from `app.js` without a circular import.
 */
async function runBenchDemo() {
  runUiIntegrityCheck();
  const orchestrator = window.__openliveTaskOrchestrator;
  if (!orchestrator) {
    emitEvidence(
      "Scenario suite skipped",
      "Task orchestrator not initialized — start a session first",
      "yellow",
    );
    return;
  }
  const suite = buildScenarioSuite(orchestrator);
  emitEvidence("Scenario suite started", `${SCENARIO_DEFINITIONS.length} deterministic scenarios`, "cyan");
  const results = await suite.runAll();
  renderScenarioResults(results);
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const inconclusive = results.filter((r) => r.status === "inconclusive").length;
  const tone = failed > 0 ? "yellow" : inconclusive > 0 ? "cyan" : "green";
  emitEvidence(
    "Scenario suite complete",
    `${passed} passed · ${failed} failed · ${inconclusive} inconclusive`,
    tone,
  );
}

function initializeBench() {
  $("#runBenchDemo")?.addEventListener("click", () => {
    runBenchDemo().catch((error) => {
      emitEvidence("Scenario suite error", error?.message ?? String(error), "yellow");
    });
  });
}

initializeWorkspace();
initializeMemory();
initializeLanguage();
initializeRail();
initializeEvidenceExport();
initializeBench();
