/**
 * OpenLive 26.7.16 — session memory + export helpers.
 */

export async function fetchMemory() {
  const r = await fetch("/v1/memory");
  return r.json().catch(() => ({ entries: [], count: 0 }));
}

export async function saveMemoryItem(role, text, tags = []) {
  const r = await fetch("/v1/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, text, tags }),
  });
  return r.json().catch(() => ({ ok: false }));
}

export async function exportMemory() {
  const r = await fetch("/v1/memory/export");
  const data = await r.json();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openlive-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return data;
}

export async function clearMemory() {
  const r = await fetch("/v1/memory/clear", { method: "POST" });
  return r.json().catch(() => ({ ok: false }));
}

export async function correctTypos(text) {
  const r = await fetch("/v1/typo/correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return r.json().catch(() => ({ original: text, corrected: text, changed: false }));
}
