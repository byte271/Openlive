/**
 * Openlive 26.7.16 — tool-calls.js
 *
 * Data model for function-calling / tool invocations surfaced in the
 * transcript. Mirrors the OpenAI Realtime API event shape:
 *
 *   response.function_call_arguments.delta   → streaming argument text
 *   response.function_call_arguments.done    → final argument JSON
 *   conversation.item.created (function_call) → completed call with result
 *
 * The UI renders each call as a card in the transcript drawer showing:
 *   - tool name + glyph
 *   - streaming argument preview (collapsed by default)
 *   - status: pending / running / completed / failed
 *   - result text when completed
 *
 * Cards are bounded; the oldest completed card is dropped when the bound
 * is exceeded. Pending cards are always preserved.
 */

const MAX_CALLS = 50;

/**
 * @typedef {Object} ToolCall
 * @property {string} id - Local stable id.
 * @property {string} callId - Provider-assigned call id (Realtime API `call_id`).
 * @property {string} name - Function/tool name.
 * @property {string} argumentsText - Streaming argument JSON text.
 * @property {string | null} result - Result text once completed.
 * @property {"pending" | "running" | "completed" | "failed"} status
 * @property {number} startedAt - epoch ms
 * @property {number | null} completedAt - epoch ms, or null while in flight
 */

/**
 * @typedef {Object} ToolDescriptor
 * @property {string} name
 * @property {string} [description]
 * @property {string} [glyph] - Single-character glyph for the card avatar.
 */

/**
 * Built-in tool descriptors. The provider can declare additional tools via
 * the manifest; declarations there override these defaults.
 *
 * @type {Readonly<Record<string, ToolDescriptor>>}
 */
export const BUILTIN_TOOLS = Object.freeze({
  weather: { name: "weather", description: "Current weather lookup", glyph: "☀" },
  stock: { name: "stock", description: "Stock quote lookup", glyph: "📈" },
  maps: { name: "maps", description: "Maps and directions", glyph: "📍" },
  web_search: { name: "web_search", description: "Web search", glyph: "🔍" },
  calculator: { name: "calculator", description: "Math evaluation", glyph: "∑" },
  calendar: { name: "calendar", description: "Calendar lookup", glyph: "📅" },
  email: { name: "email", description: "Send or read email", glyph: "✉" },
  code_interpreter: {
    name: "code_interpreter",
    description: "Run Python code",
    glyph: "▶",
  },
});

export class ToolCallLog {
  constructor(options = {}) {
    this.maxCalls = options.maxCalls ?? MAX_CALLS;
    /** @type {ToolCall[]} */
    this.calls = [];
    /** @type {Record<string, ToolDescriptor>} */
    this.tools = { ...BUILTIN_TOOLS };
    this._nextId = 1;
  }

  /**
   * Register or override a tool descriptor. Used when the provider manifest
   * declares its tool list.
   *
   * @param {ToolDescriptor} tool
   */
  registerTool(tool) {
    if (!tool?.name) return;
    this.tools[tool.name] = { ...tool };
  }

  /**
   * Begin a streaming tool call. Creates a pending entry.
   *
   * @param {string} callId
   * @param {string} name
   * @returns {ToolCall}
   */
  beginCall(callId, name) {
    const entry = {
      id: `c${this._nextId++}`,
      callId,
      name,
      argumentsText: "",
      result: null,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
    };
    this.calls.push(entry);
    this.trim();
    return entry;
  }

  /**
   * Append an arguments delta to a streaming call.
   *
   * @param {string} callId
   * @param {string} delta
   * @returns {ToolCall | null}
   */
  appendArgumentsDelta(callId, delta) {
    const entry = this.findByCallId(callId);
    if (!entry) return null;
    entry.argumentsText += delta;
    if (entry.status === "pending") entry.status = "running";
    return entry;
  }

  /**
   * Finalize the arguments for a streaming call. The call remains in
   * "running" status until `completeCall` provides a result.
   *
   * @param {string} callId
   * @param {string} finalArguments
   * @returns {ToolCall | null}
   */
  finalizeArguments(callId, finalArguments) {
    const entry = this.findByCallId(callId);
    if (!entry) return null;
    entry.argumentsText = finalArguments;
    if (entry.status === "pending") entry.status = "running";
    return entry;
  }

  /**
   * Complete a call with a result. Moves status to "completed" (or "failed"
   * if `error` is truthy).
   *
   * @param {string} callId
   * @param {string} result
   * @param {boolean} [error]
   * @returns {ToolCall | null}
   */
  completeCall(callId, result, error = false) {
    const entry = this.findByCallId(callId);
    if (!entry) return null;
    entry.result = result;
    entry.status = error ? "failed" : "completed";
    entry.completedAt = Date.now();
    return entry;
  }

  /**
   * Find a call by provider-assigned call_id.
   *
   * @param {string} callId
   * @returns {ToolCall | null}
   */
  findByCallId(callId) {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      if (this.calls[index].callId === callId) return this.calls[index];
    }
    return null;
  }

  /**
   * Clear all calls.
   */
  clear() {
    this.calls = [];
  }

  /**
   * Drop the oldest non-pending calls to stay within the bound.
   */
  trim() {
    while (this.calls.length > this.maxCalls) {
      const index = this.calls.findIndex((c) => c.status !== "pending" && c.status !== "running");
      if (index === -1) break;
      this.calls.splice(index, 1);
    }
  }

  /**
   * Look up the descriptor for a tool name. Falls back to a generic
   * descriptor with the name as the glyph.
   *
   * @param {string} name
   * @returns {ToolDescriptor}
   */
  describe(name) {
    return (
      this.tools[name] ?? {
        name,
        description: "Provider tool",
        glyph: name.slice(0, 1).toUpperCase(),
      }
    );
  }
}
