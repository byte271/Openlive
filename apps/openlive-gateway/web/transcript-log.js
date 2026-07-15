/**
 * Openlive 1.2 — transcript-log.js
 *
 * In-memory conversation transcript. Holds user, assistant, and system
 * messages, supports streaming deltas, finalization, and bounded history.
 * Pure data model — no DOM. The ui.js layer renders the log into the
 * transcript drawer.
 *
 * Design notes:
 *   - Each entry has a stable id so the UI can update existing DOM nodes
 *     when a delta arrives rather than rebuilding the list.
 *   - Assistant entries are created "pending" on the first delta and
 *     finalized on `output_text_final`. Pending entries render with a
 *     trailing ellipsis animation.
 *   - The log is bounded (default 200 entries). When the bound is exceeded
 *     the oldest non-streaming entry is dropped. This keeps memory growth
 *     predictable for long sessions.
 */

const MAX_ENTRIES = 200;

/**
 * @typedef {Object} TranscriptEntry
 * @property {string} id
 * @property {"user" | "assistant" | "system"} role
 * @property {string} text
 * @property {number} createdAt - epoch milliseconds
 * @property {boolean} pending - true while a streaming assistant turn is in flight
 * @property {string | null} generationId - links to the gateway generation id for assistant turns
 */

export class TranscriptLog {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    /** @type {TranscriptEntry[]} */
    this.entries = [];
    this._nextId = 1;
  }

  /**
   * Append a fully-formed entry. Used for user turns, system lines, and
   * assistant turns that arrive complete (e.g. from the mock provider).
   *
   * @param {"user" | "assistant" | "system"} role
   * @param {string} text
   * @param {Object} [meta]
   * @param {string | null} [meta.generationId]
   * @returns {TranscriptEntry}
   */
  append(role, text, meta = {}) {
    const entry = {
      id: `t${this._nextId++}`,
      role,
      text,
      createdAt: Date.now(),
      pending: false,
      generationId: meta.generationId ?? null,
    };
    this.entries.push(entry);
    this.trim();
    return entry;
  }

  /**
   * Begin a streaming assistant turn. Creates a pending entry and returns
   * its id. Subsequent deltas are appended via `appendDelta(id, delta)`.
   *
   * @param {string} generationId
   * @returns {TranscriptEntry}
   */
  beginAssistantStream(generationId) {
    return this.beginStream("assistant", generationId);
  }

  /**
   * Begin a streaming user turn. Mirrors beginAssistantStream for the user
   * side, used by `user_transcript_delta` events from the native-realtime
   * provider's input_audio_transcription stream.
   *
   * @param {string} generationId
   * @returns {TranscriptEntry}
   */
  beginUserStream(generationId) {
    return this.beginStream("user", generationId);
  }

  /**
   * Internal helper shared by beginAssistantStream and beginUserStream.
   *
   * @param {"user" | "assistant"} role
   * @param {string} generationId
   * @returns {TranscriptEntry}
   */
  beginStream(role, generationId) {
    const entry = {
      id: `t${this._nextId++}`,
      role,
      text: "",
      createdAt: Date.now(),
      pending: true,
      generationId,
    };
    this.entries.push(entry);
    this.trim();
    return entry;
  }

  /**
   * Append a text delta to a streaming entry. If no entry matches the id,
   * the delta is dropped — this happens when a `output_text_delta` arrives
   * without a preceding `beginAssistantStream` (e.g. an old generation
   * whose begin was cancelled). The dropped delta is logged in diagnostics.
   *
   * @param {string} id
   * @param {string} delta
   * @returns {TranscriptEntry | null}
   */
  appendDelta(id, delta) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.text += delta;
    return entry;
  }

  /**
   * Finalize a streaming entry by id, replacing its text with the final
   * form and clearing the pending flag.
   *
   * @param {string} id
   * @param {string} finalText
   * @returns {TranscriptEntry | null}
   */
  finalize(id, finalText) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.text = finalText;
    entry.pending = false;
    return entry;
  }

  /**
   * Finalize the most recent pending assistant entry by generationId.
   * Useful for the `output_text_final` event, which carries the final
   * text but not the local entry id.
   *
   * @param {string} generationId
   * @param {string} finalText
   * @returns {TranscriptEntry | null}
   */
  finalizeByGeneration(generationId, finalText) {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.role === "assistant" && entry.generationId === generationId) {
        entry.text = finalText;
        entry.pending = false;
        return entry;
      }
    }
    return null;
  }

  /**
   * Clear all entries. Used when the conversation ends.
   */
  clear() {
    this.entries = [];
  }

  /**
   * Return the most recent entry, or null if the log is empty.
   *
   * @returns {TranscriptEntry | null}
   */
  last() {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Drop the oldest non-pending entries until the log fits within
   * `maxEntries`. Pending entries are always preserved so an in-flight
   * stream is never truncated.
   */
  trim() {
    while (this.entries.length > this.maxEntries) {
      const index = this.entries.findIndex((e) => !e.pending);
      if (index === -1) break;
      this.entries.splice(index, 1);
    }
  }
}
