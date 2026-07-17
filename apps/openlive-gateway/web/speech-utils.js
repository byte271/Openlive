/**
 * OpenLive 26.7.16 — speech text utilities (filler stripping, task-intent).
 */

const FILLERS = [
  // Longer phrases first so alternation matches them before shorter tokens.
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "so yeah",
  "uh-huh",
  "uh huh",
  "uhm",
  "erm",
  "mmm",
  "mhmm",
  "mhm",
  "hmm",
  "um",
  "uh",
  "er",
  "ah",
  "eh",
  "hm",
  "mm",
  "like",
];

const FILLER_RE = new RegExp(
  `\\b(${FILLERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b(?:[.,…]+|\\.{2,}|…)?`,
  "gi",
);

/**
 * Remove common speech fillers while preserving meaning.
 * @param {string} text
 * @returns {string}
 */
export function stripFillers(text) {
  if (!text) return "";
  let out = text.replace(FILLER_RE, " ");
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/^[.,…\s]+/, "")
    .trim();
  return out;
}

/**
 * True when the utterance is only fillers / noise.
 * @param {string} text
 */
export function isOnlyFillers(text) {
  const cleaned = stripFillers(text);
  return cleaned.length < 2;
}

const TASK_MARKERS = [
  "can you",
  "could you",
  "please",
  "i need you to",
  "i want you to",
  "go ahead and",
  "build",
  "create",
  "fix",
  "implement",
  "research",
  "look up",
  "lookup",
  "search for",
  "search something about",
  "search about",
  "search ",
  "google ",
  "what is",
  "what's",
  "whats",
  "who is",
  "who was",
  "where is",
  "when did",
  "how many",
  "tell me about",
  "something about",
  "capital of",
  "calculate",
  "what time",
  "write a",
  "make a",
  "set up",
  "configure",
  "debug",
  "refactor",
  "deploy",
  "open a pr",
  "pull request",
  "investigate",
  "analyze",
  "compare",
  "summarize",
  "run the",
  "install",
  "add a feature",
  "help me search",
  "look it up",
  "look this up",
  "look that up",
  "look for",
  "just look",
  "check that",
  "check this",
  "find out",
  "find me",
  "find ",
  "info on",
  "info about",
  // Chinese task markers
  "搜索",
  "查一下",
  "查找",
  "帮我查",
  "帮我搜",
  "什么是",
  "谁是",
  "在哪里",
  "多少",
  "计算",
  "几点",
  "什么时间",
  "首都",
];

/** "Who are you?" / 你是谁 — not a web search. */
export function looksLikeIdentity(text) {
  const raw = String(text || "").trim();
  const t = raw.toLowerCase().replace(/[?!。？！.]+$/g, "").trim();
  if (
    /^(who are you|who r you|what are you|what'?s your name|whats your name|your name|introduce yourself)$/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /^(你是谁|您是谁|你叫什么|你叫什么名字|你是什么|介绍一下你自己|介绍下你自己)$/.test(raw.replace(/[?!。？！.]+$/g, "").trim())
  ) {
    return true;
  }
  if ((raw.includes("你是谁") || raw.includes("您是谁")) && raw.length <= 12) {
    return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {{ lang?: string }} [opts]
 */
export function identityReply(text, opts = {}) {
  const zh =
    (opts.lang || "").toLowerCase().startsWith("zh") ||
    /[\u3400-\u9fff]/.test(String(text || ""));
  if (zh) {
    return "我是 OpenLive，一个本地语音助手。我可以跟你聊天、上网查资料、做简单计算，也可以报时间。直接问我就行。";
  }
  return "I'm OpenLive, your local voice assistant. I can chat, look things up, do simple math, and tell the time. Just ask.";
}

/**
 * Heuristic: should this user turn use the background agent / tools?
 * @param {string} text
 */
export function looksLikeAgentTask(text) {
  const t = (text || "").toLowerCase().trim();
  if (t.length < 2) return false;
  if (isOnlyFillers(t)) return false;
  // Identity is handled specially (self-intro), still via agent for one path — mark as task
  // but backend will not search. Client may also short-circuit.
  if (looksLikeIdentity(text)) return true;
  // Keep pure conversation with the assistant off the tool path.
  if (
    /\b(how are you|are you there|can you hear|do you like|what do you think|tell me a joke|good morning|good night)\b/.test(
      t,
    )
  ) {
    return false;
  }
  // Math with digits + operators
  if (/\d/.test(t) && /[+\-*/]|plus|minus|times|divided/.test(t)) return true;
  // Do not treat bare "是谁" in 你是谁 as search (identity handled above).
  return TASK_MARKERS.some((m) => {
    if (m === "谁是" || m === "什么是") return t.includes(m) || (text || "").includes(m);
    return t.includes(m) || (text || "").includes(m);
  });
}

/**
 * Natural spoken ack while tools run — feels human, not robotic silence.
 * @param {string} intent
 * @param {{ lang?: string }} [opts]
 */
export function pickToolAck(intent, opts = {}) {
  const lang = (opts.lang || "").toLowerCase();
  const zh =
    lang.startsWith("zh") || /[\u3400-\u9fff]/.test(String(intent || ""));
  const t = (intent || "").toLowerCase().trim();
  const topic = extractTopicLabel(intent);
  if (zh) {
    if (/\d/.test(t) && /[+\-*/]|plus|minus|times|divided|加|减|乘|除/.test(t + intent)) {
      return pickOne(["我算一下。", "稍等，算一下。", "好，我来算。"]);
    }
    if (/time|几点|时间|日期/.test(t + intent)) {
      return pickOne(["我看一下时间。", "稍等。", "好。"]);
    }
    if (topic) {
      return pickOne([
        `我查一下${topic}。`,
        `稍等，正在查${topic}。`,
        `好，搜索${topic}。`,
      ]);
    }
    return pickOne(["我查一下。", "稍等，正在查找。", "好，让我搜一下。"]);
  }
  if (/\d/.test(t) && /[+\-*/]|plus|minus|times|divided|calculate|compute/.test(t)) {
    return pickOne([
      "Let me work that out.",
      "One second — calculating.",
      "Just a moment.",
    ]);
  }
  if (/time|date|day is it/.test(t)) {
    return pickOne(["Let me check the time.", "One second.", "Just a moment."]);
  }
  if (topic) {
    return pickOne([
      `Let me look up ${topic}.`,
      `Just a moment — searching for ${topic}.`,
      `Okay, checking ${topic}.`,
      `One second, looking that up.`,
    ]);
  }
  return pickOne([
    "Let me check that.",
    "Just a moment.",
    "One second — looking that up.",
    "Okay, let me search for that.",
  ]);
}

/**
 * Short topic for "searching for X" phrasing.
 * @param {string} intent
 */
export function extractTopicLabel(intent) {
  let t = String(intent || "")
    .toLowerCase()
    .replace(/[?!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const strips = [
    "can you ",
    "could you ",
    "please ",
    "help me ",
    "search for ",
    "search something about ",
    "search about ",
    "search ",
    "look up ",
    "lookup ",
    "google ",
    "tell me about ",
    "something about ",
    "what is the ",
    "what's the ",
    "whats the ",
    "what is ",
    "what's ",
    "whats ",
    "who is ",
    "who was ",
    "explain ",
    "define ",
    "capital of ",
  ];
  for (let i = 0; i < 6; i++) {
    let hit = false;
    for (const p of strips) {
      if (t.startsWith(p)) {
        t = t.slice(p.length).trim();
        hit = true;
        break;
      }
    }
    if (!hit) break;
  }
  t = t.replace(/^(the|a|an)\s+/, "").trim();
  if (!t || t.length < 2) return "";
  // Keep it short for speech.
  const words = t.split(/\s+/).slice(0, 4);
  return words
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** True when model output is private thought / planning — never show or speak. */
export function looksLikePlanningJunk(text) {
  const t = String(text || "").toLowerCase().trim();
  // Empty only — short real answers like "42" or "Paris." are fine.
  if (!t) return true;
  const bad = [
    "got it, let's",
    "got it. let's",
    "got it let's",
    "let's respond",
    "let's tackle",
    "first, the user",
    "the user asked",
    "user said",
    "user wants me to",
    "1-2 sentences",
    "no markdown",
    "respond warmly",
    "chain of thought",
    "my response should",
    "i should respond",
    "planning:",
    "thinking:",
    "thought process",
    "let me think about how",
    "function call",
    "i will use the tool",
    "i'll use the tool",
    "planning text",
    "model replied",
    "<think",
    "</think",
    "internal monologue",
    "i can't actually search",
    "i cannot search",
    "don't have access to the internet",
    "unable to browse",
    "as a language model",
  ];
  return bad.some((p) => t.includes(p));
}

/** Strip private thinking blocks; empty string if nothing safe remains. */
export function stripThinkingForUser(text) {
  let t = String(text || "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ");
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, " ");
  t = t
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      if (!l) return false;
      return !(
        l.startsWith("thought:") ||
        l.startsWith("thinking:") ||
        l.startsWith("reasoning:") ||
        l.startsWith("plan:") ||
        l.startsWith("internal:")
      );
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (looksLikePlanningJunk(t)) return "";
  return t;
}

export function softNoAnswer() {
  return "I need a clearer topic to look up. Try naming it directly, like Apple or capital of France.";
}

/**
 * Soft backchannel tokens the assistant may emit without counting as a full turn.
 */
export const BACKCHANNEL_TOKENS = Object.freeze([
  "mm-hmm",
  "mhmm",
  "yeah",
  "right",
  "okay",
  "got it",
  "I see",
]);
