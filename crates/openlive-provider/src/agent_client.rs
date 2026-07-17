//! Internal `OpenLive` agent — clean intent routing + tools + LLM.
//! Design:
//!   identity → local intro
//!   math/time/explicit-search → deterministic tools (no model needed)
//!   everything else → LLM with tools (model decides), then speak
//! Never force-search random conversation (that dumbs the product down).

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::llm_bridge::{choice_message, message_tool_calls, LlmBridge, LlmError};
use crate::tools::{
    browse_site, browse_url, identity_reply, looks_like_chitchat, looks_like_identity,
    looks_like_math, looks_like_search, looks_like_time, public_llm_answer, public_tool_answer,
    save_lab_note, search_query_from, simple_eval, soft_no_answer, try_builtin_tools,
    web_search_with_sources, Citation,
};
use crate::typo::correct_typos;

fn is_false_incapability(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("can't search")
        || t.contains("cannot search")
        || t.contains("can't look")
        || t.contains("cannot look")
        || t.contains("don't have access to the internet")
        || t.contains("do not have access to the internet")
        || t.contains("unable to browse")
        || t.contains("can't browse")
        || t.contains("cannot browse")
        || t.contains("i can't help with that")
        || t.contains("i cannot help with that")
        || t.contains("as a language model")
        || t.contains("i don't have the ability")
        || t.contains("i do not have the ability")
        || t.contains("我无法搜索")
        || t.contains("我不能上网")
        || t.contains("没有联网")
}

const AGENT_SYSTEM: &str = r#"You are OpenLive — a capable full-duplex voice AI with real tools (not a pretend chatbot).

TOOLS (call them — do not claim you cannot):
• web_search — facts about people, products, AI agents, places, news. SHORT query.
• deep_search — multi-source research when the user wants thorough answers.
• calculator — math expressions like 25*4 or 12+30.
• get_time — current time.
• list_files — list sandbox workspace files (relative paths).
• read_file — read a text file from the sandbox workspace.
• write_file — create/update a text file in the sandbox workspace.
• browse_url — fetch a public web page and read its text (no private/local hosts).
• browse_site — open a URL then follow a few same-site links (multi-page browse).
• screenshot_url — headless Chrome/Edge screenshot saved into sandbox lab/screenshots.
• print_pdf — headless Chrome/Edge print-to-PDF into sandbox lab/pdfs.
• save_note — save research notes into the sandbox lab folder.
• get_profile — read the user's durable profile (name, prefs, facts).
• remember_fact — store a short durable fact about the user.

Rules:
1. Factual / "what is" / research questions → MUST call web_search or deep_search.
2. Math → calculator. Time → get_time. File tasks → list/read/write_file. Specific URLs → browse_url/browse_site.
3. Greetings / who are you / opinions → answer directly.
4. After tools, answer using ONLY tool results. No inventing.
5. Match user language (Chinese↔Chinese, English↔English).
6. Never think aloud or narrate tool use. Never say you lack tools or internet.
7. Be clear and competent."#;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent: {0}")]
    Msg(String),
    #[error(transparent)]
    Llm(#[from] LlmError),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Internal,
    None,
}

impl AgentKind {
    #[must_use]
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" | "off" | "disabled" => Self::None,
            _ => Self::Internal,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub kind: AgentKind,
    pub intent: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    /// voice | balanced | deep
    pub thought_depth: Option<String>,
    /// general | researcher | coder | safe
    pub agent_class: Option<String>,
    /// Optional client session id for multi-turn context.
    pub session_id: Option<String>,
    /// Optional client-supplied recent transcript (user/assistant lines).
    pub prior_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResult {
    pub task_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub agent_kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools_used: Vec<String>,
    /// Upstream model HTTP status when the LLM call failed (e.g. 401, 429, 503).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_status: Option<u16>,
    /// Short model/provider error code for UI chips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_code: Option<String>,
    /// Source citations from search / browse (for transcript cards).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Citation>,
    /// Destructive sandbox action waiting for user approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<crate::pending_actions::PendingAction>,
    /// Agent class used for this turn (tool allow-list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_class: Option<String>,
    /// Multi-agent pool id when `research_pool` / deep mode ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_id: Option<String>,
}

#[derive(Clone)]
pub struct AgentClient {
    bridge: LlmBridge,
    http: Client,
}

impl AgentClient {
    pub fn new(bridge: impl Into<LlmBridge>) -> Result<Self, AgentError> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(25))
            .build()?;
        Ok(Self {
            bridge: bridge.into(),
            http,
        })
    }

    #[must_use]
    pub fn bridge(&self) -> &LlmBridge {
        &self.bridge
    }

    /// Run a multi-agent research pool (≤50 workers).
    pub async fn run_pool(
        &self,
        req: crate::agent_pool::PoolRequest,
        use_llm: bool,
    ) -> crate::agent_pool::PoolResult {
        crate::agent_pool::run_pool(self, &self.http, req, use_llm).await
    }

    /// Tracked pool — progress visible via `pool_jobs::get_status(pool_id)`.
    pub async fn run_pool_tracked(
        &self,
        req: crate::agent_pool::PoolRequest,
        use_llm: bool,
    ) -> crate::agent_pool::PoolResult {
        crate::pool_jobs::run_pool_tracked(self, &self.http, req, use_llm).await
    }

    /// Start pool in background; returns immediately with live-progress id.
    #[must_use]
    pub fn start_pool_job(
        &self,
        req: crate::agent_pool::PoolRequest,
        use_llm: bool,
    ) -> crate::pool_jobs::PoolJobStatus {
        crate::pool_jobs::start_pool_job(self.clone(), req, use_llm)
    }

    /// Fetch a public page (sandbox browser foundation).
    pub async fn browse_page(&self, url: &str) -> Result<(String, crate::tools::Citation), String> {
        browse_url(&self.http, url).await
    }

    pub async fn probe(&self, kind: AgentKind) -> AgentResult {
        if matches!(kind, AgentKind::None) {
            return AgentResult {
                task_id: String::new(),
                status: "disabled".into(),
                result: Some("agent disabled".into()),
                error: None,
                agent_kind: "none".into(),
                tools_used: vec![],
                model_status: None,
                model_code: None,
                sources: vec![],
                pending: None,
                agent_class: None,
                pool_id: None,
            };
        }
        match try_builtin_tools(&self.http, "what is 2+2").await {
            Some((ans, tools)) if ans.contains('4') => AgentResult {
                task_id: String::new(),
                status: "ok".into(),
                result: Some(format!("tools ready ({})", tools.join(","))),
                error: None,
                agent_kind: "internal".into(),
                tools_used: tools,
                model_status: None,
                model_code: None,
                sources: vec![],
                pending: None,
                agent_class: Some("general".into()),
                pool_id: None,
            },
            _ => AgentResult {
                task_id: String::new(),
                status: "ok".into(),
                result: Some("internal agent ready (search, time, calculator, chat)".into()),
                error: None,
                agent_kind: "internal".into(),
                tools_used: vec![],
                model_status: None,
                model_code: None,
                sources: vec![],
                pending: None,
                agent_class: Some("general".into()),
                pool_id: None,
            },
        }
    }

    pub async fn run(&self, request: AgentRequest) -> AgentResult {
        let task_id = uuid::Uuid::new_v4().to_string();
        if matches!(request.kind, AgentKind::None) {
            return AgentResult {
                task_id,
                status: "skipped".into(),
                result: None,
                error: Some("agent disabled".into()),
                agent_kind: "none".into(),
                tools_used: vec![],
                model_status: None,
                model_code: None,
                sources: vec![],
                pending: None,
                agent_class: None,
                pool_id: None,
            };
        }
        if request.intent.trim().is_empty() {
            return AgentResult {
                task_id,
                status: "error".into(),
                result: None,
                error: Some("intent is required".into()),
                agent_kind: "internal".into(),
                tools_used: vec![],
                model_status: None,
                model_code: Some("empty_intent".into()),
                sources: vec![],
                pending: None,
                agent_class: None,
                pool_id: None,
            };
        }

        if request.base_url.is_some() || request.api_key.is_some() || request.model.is_some() {
            self.bridge.patch_settings(|s| {
                if let Some(u) = &request.base_url {
                    if !u.is_empty() {
                        s.base_url.clone_from(u);
                    }
                }
                if let Some(k) = &request.api_key {
                    s.api_key = if k.is_empty() { None } else { Some(k.clone()) };
                }
                if let Some(m) = &request.model {
                    if !m.is_empty() {
                        s.model.clone_from(m);
                    }
                }
            });
        }

        let class = crate::agent_class::AgentClass::parse(
            request.agent_class.as_deref().unwrap_or("general"),
        );
        let class_id = class.as_str().to_owned();
        let depth = request
            .thought_depth
            .as_deref()
            .unwrap_or("voice")
            .to_ascii_lowercase();
        let intent = correct_typos(request.intent.trim());
        let session_id = request
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let client_prior = request
            .prior_context
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        // Voice / text confirm of a pending destructive action.
        if let Some(reply) = try_voice_confirm(&intent) {
            return reply_with_class(task_id, reply, &class_id);
        }

        // Build multi-turn context: durable profile + session ring + client transcript.
        let mut dialog_ctx = String::new();
        let profile_line = crate::user_profile::profile_context_line();
        if !profile_line.is_empty() {
            dialog_ctx.push_str(&profile_line);
            dialog_ctx.push('\n');
        }
        if let Some(ref sid) = session_id {
            let prev = crate::session_context::context_only(sid, 8);
            if !prev.is_empty() {
                dialog_ctx.push_str(&prev);
                dialog_ctx.push('\n');
            }
        }
        if let Some(ref prior) = client_prior {
            if !dialog_ctx.contains(prior) {
                dialog_ctx.push_str(prior);
                dialog_ctx.push('\n');
            }
        }
        let dialog_ctx = dialog_ctx.trim().to_owned();

        match self
            .tool_loop(&intent, &depth, class, dialog_ctx.as_str())
            .await
        {
            Ok((text, tools, sources, pending, pool_id)) => {
                // Persist to durable memory (best-effort) — skip if waiting for confirm.
                if pending.is_none() {
                    if let Some(ref sid) = session_id {
                        let _ = crate::session_context::append_and_context(sid, "user", &intent, 8);
                        let _ =
                            crate::session_context::append_and_context(sid, "assistant", &text, 8);
                    }
                    let mut tags = class.memory_tags();
                    tags.push("turn".into());
                    if let Some(ref sid) = session_id {
                        tags.push(format!("session:{sid}"));
                    }
                    let _ = crate::memory_store::append_memory("user", &intent, tags.clone());
                    let mut atags = class.memory_tags();
                    atags.extend(tools.iter().cloned());
                    if let Some(ref sid) = session_id {
                        atags.push(format!("session:{sid}"));
                    }
                    let _ = crate::memory_store::append_memory("assistant", &text, atags);
                    for src in sources.iter().take(6) {
                        let note = format!("source: {} — {}", src.title, src.url);
                        let mut stags = class.memory_tags();
                        stags.push("citation".into());
                        stags.push("search".into());
                        let _ = crate::memory_store::append_memory("source", &note, stags);
                    }
                }
                let status = if pending.is_some() {
                    "needs_confirm"
                } else {
                    "completed"
                };
                AgentResult {
                    task_id,
                    status: status.into(),
                    result: Some(text),
                    error: None,
                    agent_kind: "internal".into(),
                    tools_used: tools,
                    model_status: None,
                    model_code: None,
                    sources,
                    pending,
                    agent_class: Some(class_id),
                    pool_id,
                }
            }
            Err(e) => {
                let (model_status, model_code) = match &e {
                    AgentError::Llm(le) => {
                        let st = le.status_code();
                        let code = if st == 401 || st == 403 {
                            "auth"
                        } else if st == 429 {
                            "rate_limit"
                        } else if st == 404 {
                            "model_not_found"
                        } else if st >= 500 {
                            "upstream"
                        } else if st > 0 {
                            "model_error"
                        } else {
                            "config"
                        };
                        (if st > 0 { Some(st) } else { None }, Some(code.into()))
                    }
                    AgentError::Msg(_) => (None, Some("agent".into())),
                    AgentError::Http(_) => (None, Some("network".into())),
                };
                AgentResult {
                    task_id,
                    status: "error".into(),
                    result: None,
                    error: Some(e.to_string()),
                    agent_kind: "internal".into(),
                    tools_used: vec![],
                    model_status,
                    model_code,
                    sources: vec![],
                    pending: None,
                    agent_class: Some(class_id),
                    pool_id: None,
                }
            }
        }
    }

    async fn tool_loop(
        &self,
        intent: &str,
        thought_depth: &str,
        class: crate::agent_class::AgentClass,
        dialog_ctx: &str,
    ) -> Result<
        (
            String,
            Vec<String>,
            Vec<Citation>,
            Option<crate::pending_actions::PendingAction>,
            Option<String>,
        ),
        AgentError,
    > {
        let intent = intent.trim();
        let max_tokens = match thought_depth {
            "deep" => 400u32,
            "balanced" => 220u32,
            _ => 140u32, // voice
        };
        let style = match thought_depth {
            "deep" => "Give a thorough, research-style answer (still spoken-friendly paragraphs). Use tools when facts matter.",
            "balanced" => "Answer clearly in a few short sentences. Use tools for facts.",
            _ => "Answer in 1–2 short spoken sentences. Use tools for facts.",
        };
        let style = if dialog_ctx.is_empty() {
            style.to_owned()
        } else {
            format!(
                "{style}\n\nRecent conversation (use for continuity; do not repeat unless asked):\n{dialog_ctx}"
            )
        };
        let style = style.as_str();

        // ── 1. Identity (never search) ───────────────────────────────────
        if looks_like_identity(intent) {
            return Ok((
                identity_reply(intent),
                vec!["identity".into()],
                vec![],
                None,
                None,
            ));
        }

        // ── 1a. Continuity from session dialog without requiring an LLM ──
        if let Some(ans) = answer_from_dialog_context(intent, dialog_ctx) {
            return Ok((ans, vec!["session_context".into()], vec![], None, None));
        }

        // ── 1b. Deep research mode → multi-agent pool ───────────────────
        if thought_depth == "deep" && looks_like_research(intent) {
            let n = if intent.len() > 80 { 6 } else { 4 };
            let pool = crate::pool_jobs::run_pool_tracked(
                self,
                &self.http,
                crate::agent_pool::PoolRequest {
                    intent: intent.to_owned(),
                    tasks: vec![],
                    max_agents: Some(n),
                    thought_depth: Some("deep".into()),
                },
                false,
            )
            .await;
            if let Some(syn) = pool.synthesis {
                let mut tools = vec!["research_pool".into()];
                tools.extend(
                    pool.results
                        .iter()
                        .flat_map(|r| r.tools_used.iter().cloned())
                        .take(8),
                );
                let sources = pool_sources_from_results(&pool.results);
                // Optional LLM polish into spoken research brief.
                if self.bridge.settings().can_chat() {
                    if let Ok(polished) = self.polish_tool_answer(intent, &syn).await {
                        if let Some(safe) = public_llm_answer(&polished) {
                            if !is_false_incapability(&safe) {
                                return Ok((safe, tools, sources, None, None));
                            }
                        }
                    }
                }
                return Ok((syn, tools, sources, None, Some(pool.pool_id)));
            }
        }

        // ── 2. Deterministic tools when intent is crystal-clear ──────────
        // Math / time first (before "what is …" is treated as search).
        if looks_like_math(intent) || looks_like_time(intent) {
            if let Some((raw, tools)) = try_builtin_tools(&self.http, intent).await {
                let answer = public_tool_answer(intent, &raw);
                if self.bridge.settings().can_chat() && needs_language_polish(intent, &answer) {
                    if let Ok(polished) = self.polish_tool_answer(intent, &answer).await {
                        if let Some(safe) = public_llm_answer(&polished) {
                            if !is_false_incapability(&safe) {
                                return Ok((safe, tools, vec![], None, None));
                            }
                        }
                    }
                }
                return Ok((answer, tools, vec![], None, None));
            }
        }
        if looks_like_search(intent) {
            let q = search_query_from(intent);
            if q.len() >= 2 {
                match web_search_with_sources(&self.http, &q).await {
                    Ok((raw, sources)) => {
                        let answer = public_tool_answer(intent, &raw);
                        let tools = vec!["web_search".into()];
                        if self.bridge.settings().can_chat()
                            && needs_language_polish(intent, &answer)
                        {
                            if let Ok(polished) = self.polish_tool_answer(intent, &answer).await {
                                if let Some(safe) = public_llm_answer(&polished) {
                                    if !is_false_incapability(&safe) {
                                        return Ok((safe, tools, sources, None, None));
                                    }
                                }
                            }
                        }
                        return Ok((answer, tools, sources, None, None));
                    }
                    Err(_) => {
                        return Ok((
                            if crate::tools::has_cjk(intent) {
                                format!("没查到「{q}」的可靠结果。换个更短的关键词再试。")
                            } else {
                                format!(
                                    "I couldn't find solid results for '{q}'. Try a shorter name."
                                )
                            },
                            vec!["web_search".into()],
                            vec![],
                            None,
                            None,
                        ));
                    }
                }
            }
        }

        // ── 3. LLM + tools (model is smart here — give it tools, not a cage) ─
        if self.bridge.settings().can_chat() {
            if let Ok((text, tools, sources, pending, pool_id)) =
                self.llm_tool_round(intent, style, max_tokens, class).await
            {
                return Ok((text, tools, sources, pending, pool_id));
            }
            // Plain chat fallback (greetings, opinions, help).
            match self.bridge.chat_voice(intent).await {
                Ok(plain) => {
                    if let Some(safe) = public_llm_answer(&plain) {
                        if is_false_incapability(&safe) {
                            if looks_like_search(intent) || intent.contains('?') {
                                let q = search_query_from(intent);
                                if q.len() >= 2 {
                                    if let Ok((raw, sources)) =
                                        web_search_with_sources(&self.http, &q).await
                                    {
                                        return Ok((
                                            public_tool_answer(intent, &raw),
                                            vec!["web_search".into()],
                                            sources,
                                            None,
                                            None,
                                        ));
                                    }
                                }
                            }
                        } else {
                            return Ok((safe, vec![], vec![], None, None));
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            }
            return Ok((soft_no_answer(), vec![], vec![], None, None));
        }

        // ── 4. Offline: tools only ───────────────────────────────────────
        if looks_like_search(intent) {
            let q = search_query_from(intent);
            if q.len() >= 2 {
                if let Ok((raw, sources)) = web_search_with_sources(&self.http, &q).await {
                    return Ok((
                        public_tool_answer(intent, &raw),
                        vec!["web_search".into()],
                        sources,
                        None,
                        None,
                    ));
                }
            }
        }
        if let Some((raw, tools)) = try_builtin_tools(&self.http, intent).await {
            return Ok((public_tool_answer(intent, &raw), tools, vec![], None, None));
        }
        if looks_like_chitchat(intent) {
            return Ok((
                identity_reply(intent),
                vec!["identity".into()],
                vec![],
                None,
                None,
            ));
        }

        Err(AgentError::Msg(if crate::tools::has_cjk(intent) {
            "当前没有可用的语言模型。请在设置里配置 API key，或直接说：搜索苹果、现在几点、计算 12+30。"
                    .into()
        } else {
            "No language model configured. Open Settings, add an API key, or try: search Apple, what time is it, 12+30.".into()
        }))
    }

    /// One LLM round with tools; execute calls; return spoken answer from tool facts or model text.
    async fn llm_tool_round(
        &self,
        intent: &str,
        style: &str,
        max_tokens: u32,
        class: crate::agent_class::AgentClass,
    ) -> Result<
        (
            String,
            Vec<String>,
            Vec<Citation>,
            Option<crate::pending_actions::PendingAction>,
            Option<String>,
        ),
        AgentError,
    > {
        let tools = tool_definitions_for(class);
        let mem = crate::memory_store::load_memory();
        // Memory slice: prefer entries tagged with this agent class, fall back to recent.
        let class_tag = class.as_str();
        let mut class_entries: Vec<_> = mem
            .entries
            .iter()
            .filter(|e| e.tags.iter().any(|t| t == class_tag))
            .cloned()
            .collect();
        if class_entries.len() < 3 {
            class_entries = mem.entries.clone();
        }
        let mem_snip: String = class_entries
            .iter()
            .rev()
            .take(6)
            .map(|e| {
                format!(
                    "{}: {}",
                    e.role,
                    e.text.chars().take(120).collect::<String>()
                )
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let system = format!(
            "{AGENT_SYSTEM}\n\nAgent class: {class_tag} (only use allowed tools).\nOutput style: {style}\n\nRecent memory (context):\n{}",
            if mem_snip.is_empty() {
                "(empty)".into()
            } else {
                mem_snip
            }
        );
        let mut messages = vec![
            json!({ "role": "system", "content": system }),
            json!({ "role": "user", "content": intent }),
        ];

        let raw = self
            .bridge
            .chat_raw(&messages, Some(&tools))
            .await
            .map_err(AgentError::from)?;

        let message =
            choice_message(&raw).ok_or_else(|| AgentError::Msg("empty model message".into()))?;

        let calls = message_tool_calls(&message);
        if calls.is_empty() {
            // Model answered without tools.
            if let Some(content) = message
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
            {
                if !content.is_empty() {
                    if let Some(safe) = public_llm_answer(content) {
                        if !is_false_incapability(&safe) {
                            return Ok((safe, vec![], vec![], None, None));
                        }
                    }
                }
            }
            return Err(AgentError::Msg("model returned no usable content".into()));
        }

        let mut tools_used = Vec::new();
        let mut tool_blobs = Vec::new();
        let mut sources = Vec::new();
        let mut pending = None;
        messages.push(message);

        for call in calls {
            let name = call
                .pointer("/function/name")
                .or_else(|| call.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let args_str = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
            tools_used.push(name.clone());
            let (result, cites, pend) = self.execute_tool(&name, &args, class).await;
            sources.extend(cites);
            if pend.is_some() && pending.is_none() {
                pending = pend;
            }
            tool_blobs.push(result.clone());
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result,
            }));
        }

        // Destructive action awaiting user confirmation — don't invent a spoken answer over it.
        if let Some(p) = pending.clone() {
            return Ok((p.message.clone(), tools_used, sources, Some(p), None));
        }

        let joined = tool_blobs.join("\n\n");
        let factual = public_tool_answer(intent, &joined);

        // Second pass: natural spoken phrasing from tool facts (keeps model smart).
        if self.bridge.settings().can_chat() {
            messages.push(json!({
                "role": "user",
                "content": format!(
                    "Using ONLY the tool results above, answer the user in 1-3 short spoken sentences. Language: same as the user. No markdown. User said: {intent}"
                )
            }));
            if let Ok(final_text) = self.bridge.chat_messages(&messages, None, max_tokens).await {
                if let Some(safe) = public_llm_answer(&final_text) {
                    if !is_false_incapability(&safe) && safe.len() > 8 {
                        return Ok((safe, tools_used, sources, None, None));
                    }
                }
            }
        }

        Ok((factual, tools_used, sources, None, None))
    }

    async fn polish_tool_answer(&self, intent: &str, facts: &str) -> Result<String, LlmError> {
        let messages = vec![
            json!({
                "role": "system",
                "content": "Rewrite the facts into 1-2 short spoken sentences for a voice assistant. Same language as the user. No markdown. No planning."
            }),
            json!({
                "role": "user",
                "content": format!("User: {intent}\n\nFacts:\n{facts}")
            }),
        ];
        self.bridge.chat_messages(&messages, None, 140).await
    }

    async fn execute_tool(
        &self,
        name: &str,
        args: &Value,
        class: crate::agent_class::AgentClass,
    ) -> (
        String,
        Vec<Citation>,
        Option<crate::pending_actions::PendingAction>,
    ) {
        if !class.allows(name) {
            return (
                format!(
                    "tool '{name}' is not allowed for agent class '{}'",
                    class.as_str()
                ),
                vec![],
                None,
            );
        }
        match name {
            "web_search" => {
                let q = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if q.is_empty() {
                    return ("error: empty query".into(), vec![], None);
                }
                match web_search_with_sources(&self.http, q).await {
                    Ok((text, sources)) => (text, sources, None),
                    Err(e) => (format!("search error: {e}"), vec![], None),
                }
            }
            "deep_search" => {
                let q = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if q.is_empty() {
                    return ("error: empty query".into(), vec![], None);
                }
                let angles = [
                    q.to_owned(),
                    format!("{q} overview definition"),
                    format!("{q} examples use cases"),
                    format!("{q} vs alternatives"),
                ];
                let mut parts = Vec::new();
                let mut sources = Vec::new();
                for (i, angle) in angles.iter().enumerate() {
                    match web_search_with_sources(&self.http, angle).await {
                        Ok((s, mut cites)) => {
                            if !parts.iter().any(|p: &String| p == &s) {
                                parts.push(format!("[source {}] {s}", i + 1));
                                sources.append(&mut cites);
                            }
                        }
                        Err(e) if i == 0 => parts.push(format!("primary search error: {e}")),
                        Err(_) => {}
                    }
                }
                if parts.is_empty() {
                    ("deep_search found no results".into(), sources, None)
                } else {
                    (parts.join("\n\n---\n\n"), sources, None)
                }
            }
            "browse_url" => {
                let url = args.get("url").and_then(Value::as_str).unwrap_or("").trim();
                if url.is_empty() {
                    return ("error: empty url".into(), vec![], None);
                }
                let engine = crate::tools::BrowseEngine::parse(
                    args.get("engine").and_then(Value::as_str).unwrap_or("auto"),
                );
                match crate::tools::browse_url_with_engine(&self.http, url, engine).await {
                    Ok((text, cite, _)) => {
                        let eng = match engine {
                            crate::tools::BrowseEngine::Http => "http",
                            crate::tools::BrowseEngine::Headless => "headless",
                            crate::tools::BrowseEngine::Auto => "auto",
                        };
                        (format!("[{eng}] {text}"), vec![cite], None)
                    }
                    Err(e) => (format!("browse_url error: {e}"), vec![], None),
                }
            }
            "browse_site" => {
                let url = args.get("url").and_then(Value::as_str).unwrap_or("").trim();
                if url.is_empty() {
                    return ("error: empty url".into(), vec![], None);
                }
                let max = args
                    .get("max_links")
                    .and_then(Value::as_u64)
                    .unwrap_or(2)
                    .clamp(0, 5) as usize;
                match browse_site(&self.http, url, max).await {
                    Ok((text, sources)) => (text, sources, None),
                    Err(e) => (format!("browse_site error: {e}"), vec![], None),
                }
            }
            "screenshot_url" => {
                let url = args.get("url").and_then(Value::as_str).unwrap_or("").trim();
                if url.is_empty() {
                    return ("error: empty url".into(), vec![], None);
                }
                let width = args
                    .get("width")
                    .and_then(Value::as_u64)
                    .unwrap_or(1280)
                    .clamp(320, 2560) as u32;
                let height = args
                    .get("height")
                    .and_then(Value::as_u64)
                    .unwrap_or(800)
                    .clamp(240, 4096) as u32;
                let url = url.to_owned();
                match tokio::task::spawn_blocking(move || {
                    crate::headless_browser::headless_screenshot(&url, width, height)
                })
                .await
                {
                    Ok(Ok(shot)) => (
                        format!(
                            "screenshot saved: {} ({} bytes, {}x{}, via {})",
                            shot.relative_path, shot.bytes, shot.width, shot.height, shot.browser
                        ),
                        vec![Citation {
                            title: format!("screenshot {}", shot.relative_path),
                            url: shot.url,
                            snippet: shot.path,
                        }],
                        None,
                    ),
                    Ok(Err(e)) => (format!("screenshot_url error: {e}"), vec![], None),
                    Err(e) => (format!("screenshot_url task error: {e}"), vec![], None),
                }
            }
            "print_pdf" => {
                let url = args.get("url").and_then(Value::as_str).unwrap_or("").trim();
                if url.is_empty() {
                    return ("error: empty url".into(), vec![], None);
                }
                let url = url.to_owned();
                match tokio::task::spawn_blocking(move || {
                    crate::headless_browser::headless_pdf(&url)
                })
                .await
                {
                    Ok(Ok(pdf)) => (
                        format!(
                            "pdf saved: {} ({} bytes, via {})",
                            pdf.relative_path, pdf.bytes, pdf.browser
                        ),
                        vec![Citation {
                            title: format!("pdf {}", pdf.relative_path),
                            url: pdf.url,
                            snippet: pdf.path,
                        }],
                        None,
                    ),
                    Ok(Err(e)) => (format!("print_pdf error: {e}"), vec![], None),
                    Err(e) => (format!("print_pdf task error: {e}"), vec![], None),
                }
            }
            "save_note" => {
                let name = args
                    .get("name")
                    .or_else(|| args.get("path"))
                    .and_then(Value::as_str)
                    .unwrap_or("note")
                    .trim();
                let content = args.get("content").and_then(Value::as_str).unwrap_or("");
                if content.is_empty() {
                    return ("error: empty content".into(), vec![], None);
                }
                match save_lab_note(name, content) {
                    Ok(msg) => (msg, vec![], None),
                    Err(e) => (format!("save_note error: {e}"), vec![], None),
                }
            }
            "get_profile" => {
                let line = crate::user_profile::profile_context_line();
                if line.is_empty() {
                    ("profile is empty".into(), vec![], None)
                } else {
                    (line, vec![], None)
                }
            }
            "remember_fact" => {
                let fact = args
                    .get("fact")
                    .or_else(|| args.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if fact.is_empty() {
                    return ("error: empty fact".into(), vec![], None);
                }
                match crate::user_profile::add_fact(fact) {
                    Ok(_) => (format!("Remembered: {fact}"), vec![], None),
                    Err(e) => (format!("remember_fact error: {e}"), vec![], None),
                }
            }
            "research_pool" => {
                let q = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if q.is_empty() {
                    return ("error: empty query".into(), vec![], None);
                }
                let n = args
                    .get("agents")
                    .and_then(Value::as_u64)
                    .unwrap_or(4)
                    .clamp(1, crate::agent_pool::MAX_AGENTS as u64)
                    as usize;
                let pool = crate::pool_jobs::run_pool_tracked(
                    self,
                    &self.http,
                    crate::agent_pool::PoolRequest {
                        intent: q.to_owned(),
                        tasks: vec![],
                        max_agents: Some(n),
                        thought_depth: Some("deep".into()),
                    },
                    false,
                )
                .await;
                let sources = pool_sources_from_results(&pool.results);
                let text = pool.synthesis.unwrap_or_else(|| {
                    pool.results
                        .iter()
                        .filter_map(|r| r.result.as_ref())
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n\n")
                });
                (text, sources, None)
            }
            "get_time" => (
                try_builtin_tools(&self.http, "what time is it")
                    .await
                    .map_or_else(|| "time unavailable".into(), |(a, _)| a),
                vec![],
                None,
            ),
            "calculator" => {
                let expr = args.get("expression").and_then(Value::as_str).unwrap_or("");
                let text = match simple_eval(expr) {
                    Ok(v) => format!("{expr} = {v}"),
                    Err(e) => format!("calc error: {e}"),
                };
                (text, vec![], None)
            }
            "list_files" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let text = match crate::sandbox::list_files(path) {
                    Ok(files) => {
                        if files.is_empty() {
                            "workspace is empty".into()
                        } else {
                            files.join("\n")
                        }
                    }
                    Err(e) => format!("list_files error: {e}"),
                };
                (text, vec![], None)
            }
            "read_file" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let text = match crate::sandbox::read_file(path) {
                    Ok(t) => t,
                    Err(e) => format!("read_file error: {e}"),
                };
                (text, vec![], None)
            }
            "write_file" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let content = args.get("content").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    return ("error: empty path".into(), vec![], None);
                }
                // Overwrite requires user confirmation.
                let exists = crate::sandbox::path_exists(path).unwrap_or(false);
                if exists {
                    let pending = crate::pending_actions::queue_write_file(
                        path,
                        content,
                        &format!("Overwrite existing sandbox file “{path}”?"),
                    );
                    return (
                        format!(
                            "CONFIRM_REQUIRED: overwrite “{path}” ({} bytes). Waiting for user approval.",
                            content.len()
                        ),
                        vec![],
                        Some(pending),
                    );
                }
                let text = match crate::sandbox::write_file(path, content) {
                    Ok(t) => t,
                    Err(e) => format!("write_file error: {e}"),
                };
                (text, vec![], None)
            }
            "delete_file" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if path.is_empty() {
                    return ("error: empty path".into(), vec![], None);
                }
                let pending = crate::pending_actions::queue_delete_file(path);
                (
                    format!("CONFIRM_REQUIRED: delete “{path}”. Waiting for user approval."),
                    vec![],
                    Some(pending),
                )
            }
            _ => (format!("unknown tool: {name}"), vec![], None),
        }
    }
}

/// Answer simple follow-ups from prior turns when no LLM is needed.
fn answer_from_dialog_context(intent: &str, dialog_ctx: &str) -> Option<String> {
    let intent = intent.trim();
    let dialog_ctx = dialog_ctx.trim();
    if intent.is_empty() {
        return None;
    }
    let lower = intent.to_ascii_lowercase();

    // Remember name: "my name is Alex" / "我叫小明" — durable profile.
    if let Some(name) = extract_stated_name(intent) {
        let _ = crate::user_profile::set_display_name(&name);
        return Some(if crate::tools::has_cjk(intent) {
            format!("好的，我记住了，你是{name}。")
        } else {
            format!("Got it — I'll remember your name is {name}.")
        });
    }

    // Prefer durable profile, then dialog context.
    let profile = crate::user_profile::load_profile();
    let profile_name = profile
        .display_name
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .cloned();

    // Recall name
    if lower.contains("my name")
        || lower.contains("what's my name")
        || lower.contains("whats my name")
        || lower.contains("who am i")
        || intent.contains("我叫什么")
        || intent.contains("我的名字")
    {
        if let Some(name) = profile_name
            .clone()
            .or_else(|| find_name_in_context(dialog_ctx))
        {
            return Some(if crate::tools::has_cjk(intent) {
                format!("你说过你叫{name}。")
            } else {
                format!("You said your name is {name}.")
            });
        }
    }

    // "where am i" / timezone
    if lower.contains("what timezone")
        || lower.contains("my timezone")
        || lower.contains("what time zone")
        || intent.contains("时区")
    {
        if let Some(tz) = profile.timezone.clone().filter(|s| !s.is_empty()) {
            return Some(if crate::tools::has_cjk(intent) {
                format!("你的时区是 {tz}。")
            } else {
                format!("Your timezone is set to {tz}.")
            });
        }
    }

    // "what do you know about me" / summarize profile
    if lower.contains("what do you know about me")
        || lower.contains("what do you remember about me")
        || lower.contains("tell me about me")
        || lower.contains("my profile")
        || intent.contains("你记得我什么")
        || intent.contains("你了解我")
        || intent.contains("关于我")
    {
        let summary = summarize_profile_for_user(&profile, crate::tools::has_cjk(intent));
        if !summary.is_empty() {
            return Some(summary);
        }
    }

    // Remember fact: "remember that I like tea"
    if lower.starts_with("remember that ")
        || lower.starts_with("remember i ")
        || intent.starts_with("记住")
    {
        let fact = intent
            .trim()
            .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '记' && c != '住')
            .to_owned();
        let fact = if lower.starts_with("remember that ") {
            intent["remember that ".len()..].trim().to_owned()
        } else if lower.starts_with("remember i ") {
            format!("I {}", intent["remember i ".len()..].trim())
        } else if let Some(rest) = intent.strip_prefix("记住") {
            rest.trim()
                .trim_start_matches(['，', ',', '：', ':'])
                .trim()
                .to_owned()
        } else {
            fact
        };
        if fact.len() >= 3 {
            let _ = crate::user_profile::add_fact(&fact);
            return Some(if crate::tools::has_cjk(intent) {
                format!("好的，我记住了：{fact}")
            } else {
                format!("Got it — I'll remember that {fact}.")
            });
        }
    }

    if dialog_ctx.is_empty() && profile_name.is_none() {
        return None;
    }

    // "what did I just say" / last user line
    if lower.contains("what did i say")
        || lower.contains("what did i just")
        || intent.contains("我刚才说")
        || intent.contains("我刚说")
    {
        if let Some(line) = last_user_line(dialog_ctx) {
            return Some(if crate::tools::has_cjk(intent) {
                format!("你刚才说：{line}")
            } else {
                format!("You said: {line}")
            });
        }
    }

    None
}

fn summarize_profile_for_user(p: &crate::user_profile::UserProfile, cjk: bool) -> String {
    let mut bits = Vec::new();
    if let Some(n) = p.display_name.as_ref().filter(|s| !s.is_empty()) {
        bits.push(if cjk {
            format!("你的名字是{n}")
        } else {
            format!("your name is {n}")
        });
    }
    if let Some(tz) = p.timezone.as_ref().filter(|s| !s.is_empty()) {
        bits.push(if cjk {
            format!("时区是{tz}")
        } else {
            format!("timezone {tz}")
        });
    }
    if let Some(l) = p.preferred_language.as_ref().filter(|s| !s.is_empty()) {
        bits.push(if cjk {
            format!("语言偏好 {l}")
        } else {
            format!("language preference {l}")
        });
    }
    for f in p.facts.iter().rev().take(4) {
        bits.push(f.clone());
    }
    if let Some(n) = p.notes.as_ref().filter(|s| !s.is_empty()) {
        bits.push(if cjk {
            format!("备注：{}", n.chars().take(80).collect::<String>())
        } else {
            format!("notes: {}", n.chars().take(80).collect::<String>())
        });
    }
    if bits.is_empty() {
        return if cjk {
            "我还不太了解你。可以说「我叫…」或「记住…」。".into()
        } else {
            "I don't know much about you yet. Tell me your name or say “remember that…”.".into()
        };
    }
    if cjk {
        format!("我目前记得：{}。", bits.join("；"))
    } else {
        format!("Here's what I know: {}.", bits.join("; "))
    }
}

fn extract_stated_name(intent: &str) -> Option<String> {
    let t = intent.trim();
    let lower = t.to_ascii_lowercase();
    for prefix in ["my name is ", "i am ", "i'm ", "im "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let name = rest.trim().trim_end_matches(['.', '!', '?', ',']).trim();
            if name.len() >= 2 && name.len() <= 40 {
                // Preserve original casing from intent
                let start = prefix.len();
                let raw = t.get(start..).unwrap_or(name).trim();
                let raw = raw.trim_end_matches(['.', '!', '?', ',']).trim();
                if !raw.is_empty() {
                    return Some(raw.to_owned());
                }
            }
        }
    }
    if let Some(rest) = t.strip_prefix("我叫") {
        let name = rest
            .trim()
            .trim_end_matches(['。', '！', '？', '.', '!', '?']);
        if !name.is_empty() && name.chars().count() <= 20 {
            return Some(name.to_owned());
        }
    }
    None
}

fn find_name_in_context(ctx: &str) -> Option<String> {
    for line in ctx.lines().rev() {
        let line = line.trim();
        let content = line
            .strip_prefix("user: ")
            .or_else(|| line.strip_prefix("User: "))
            .unwrap_or(line);
        if let Some(n) = extract_stated_name(content) {
            return Some(n);
        }
        // Also parse assistant remember lines
        if let Some(rest) = content
            .to_ascii_lowercase()
            .find("name is ")
            .map(|i| &content[i + 8..])
        {
            let name = rest.trim().trim_end_matches(['.', '!', '?', ',']).trim();
            if name.len() >= 2 && name.len() <= 40 && !name.contains("khan") {
                return Some(name.to_owned());
            }
        }
    }
    None
}

fn last_user_line(ctx: &str) -> Option<String> {
    for line in ctx.lines().rev() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("user: ")
            .or_else(|| line.strip_prefix("User: "))
        {
            let t = rest.trim();
            if !t.is_empty() {
                return Some(t.to_owned());
            }
        }
    }
    None
}

fn try_voice_confirm(intent: &str) -> Option<AgentResult> {
    let t = intent.trim().to_ascii_lowercase();
    let approve = matches!(
        t.as_str(),
        "yes"
            | "y"
            | "ok"
            | "okay"
            | "approve"
            | "confirm"
            | "do it"
            | "go ahead"
            | "sure"
            | "yeah"
            | "yep"
            | "好"
            | "好的"
            | "确认"
            | "同意"
            | "可以"
            | "行"
    ) || t.starts_with("yes ")
        || t.starts_with("approve ")
        || t == "confirm it"
        || t == "please do";
    let deny = matches!(
        t.as_str(),
        "no" | "n"
            | "cancel"
            | "deny"
            | "stop"
            | "don't"
            | "dont"
            | "never mind"
            | "nevermind"
            | "取消"
            | "不要"
            | "别"
            | "拒绝"
    ) || t.starts_with("no ")
        || t.starts_with("cancel ");
    if !approve && !deny {
        return None;
    }
    let pending = crate::pending_actions::list_pending();
    let Some(last) = pending.last() else {
        return Some(AgentResult {
            task_id: uuid::Uuid::new_v4().to_string(),
            status: "completed".into(),
            result: Some(if approve {
                "There's nothing waiting for confirmation.".into()
            } else {
                "Nothing to cancel.".into()
            }),
            error: None,
            agent_kind: "internal".into(),
            tools_used: vec!["confirm".into()],
            model_status: None,
            model_code: None,
            sources: vec![],
            pending: None,
            agent_class: None,
            pool_id: None,
        });
    };
    if approve {
        match crate::pending_actions::execute_approved(&last.id) {
            Ok(msg) => Some(AgentResult {
                task_id: uuid::Uuid::new_v4().to_string(),
                status: "completed".into(),
                result: Some(msg),
                error: None,
                agent_kind: "internal".into(),
                tools_used: vec!["confirm".into()],
                model_status: None,
                model_code: None,
                sources: vec![],
                pending: None,
                agent_class: None,
                pool_id: None,
            }),
            Err(e) => Some(AgentResult {
                task_id: uuid::Uuid::new_v4().to_string(),
                status: "error".into(),
                result: None,
                error: Some(e),
                agent_kind: "internal".into(),
                tools_used: vec!["confirm".into()],
                model_status: None,
                model_code: Some("confirm".into()),
                sources: vec![],
                pending: None,
                agent_class: None,
                pool_id: None,
            }),
        }
    } else {
        let _ = crate::pending_actions::reject(&last.id);
        Some(AgentResult {
            task_id: uuid::Uuid::new_v4().to_string(),
            status: "completed".into(),
            result: Some("Cancelled — I didn’t change anything.".into()),
            error: None,
            agent_kind: "internal".into(),
            tools_used: vec!["confirm".into()],
            model_status: None,
            model_code: None,
            sources: vec![],
            pending: None,
            agent_class: None,
            pool_id: None,
        })
    }
}

fn reply_with_class(task_id: String, mut r: AgentResult, class_id: &str) -> AgentResult {
    r.task_id = task_id;
    r.agent_class = Some(class_id.to_owned());
    r
}

fn pool_sources_from_results(results: &[crate::agent_pool::PoolAgentResult]) -> Vec<Citation> {
    results
        .iter()
        .filter_map(|r| {
            let text = r.result.as_ref()?;
            let title = r.intent.chars().take(80).collect::<String>();
            let snippet = text.chars().take(160).collect::<String>();
            Some(Citation {
                title,
                url: format!("agent://pool/{}", r.index),
                snippet,
            })
        })
        .take(8)
        .collect()
}

fn needs_language_polish(intent: &str, answer: &str) -> bool {
    // Polish when user speaks Chinese but tool dump is English-heavy.
    crate::tools::has_cjk(intent) && !crate::tools::has_cjk(answer) && answer.len() > 40
}

fn looks_like_research(intent: &str) -> bool {
    let t = intent.to_ascii_lowercase();
    t.contains("research")
        || t.contains("deep dive")
        || t.contains("thoroughly")
        || t.contains("in depth")
        || t.contains("in-depth")
        || t.contains("investigate")
        || t.contains("调研")
        || t.contains("深入研究")
        || t.contains("详细介绍")
        || t.contains("全面了解")
        || (t.contains("what is") && t.len() > 18)
        || (t.contains("什么是") && intent.chars().count() > 6)
}

fn tool_definitions_for(class: crate::agent_class::AgentClass) -> Vec<Value> {
    tool_definitions()
        .into_iter()
        .filter(|t| {
            t.pointer("/function/name")
                .and_then(Value::as_str)
                .is_some_and(|n| class.allows(n))
        })
        .collect()
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search for facts: people, products, AI agents, places, news, definitions. SHORT query.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Short search keywords" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "deep_search",
                "description": "Deeper multi-query research when the user wants thorough answers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "research_pool",
                "description": "Spawn multiple parallel research agents (up to 50) for broad coverage. Use for 'research X thoroughly' or multi-facet questions.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "agents": { "type": "integer", "description": "Number of parallel agents (1-50, default 4)" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_time",
                "description": "Get the current time (UTC).",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "Evaluate arithmetic. Pass expression like 12+30 or 25*4.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": { "type": "string" }
                    },
                    "required": ["expression"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files in the OpenLive sandbox workspace. path is relative ('' = root).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file from the sandbox workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write a UTF-8 text file into the sandbox workspace (creates folders as needed).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "browse_url",
                "description": "Fetch a public https URL and read its main text (sandbox browser). engine: auto|http|headless. Headless uses system Chrome/Edge for JS pages.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Public http(s) URL" },
                        "engine": { "type": "string", "description": "auto (default), http, or headless" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "browse_site",
                "description": "Multi-page browse: open a URL then follow a few same-site links. Use for deeper website reading.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" },
                        "max_links": { "type": "integer", "description": "Extra pages to follow (0-5, default 2)" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "screenshot_url",
                "description": "Take a headless Chrome/Edge screenshot of a public URL; saves PNG into sandbox lab/screenshots/.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" },
                        "width": { "type": "integer", "description": "Viewport width (default 1280)" },
                        "height": { "type": "integer", "description": "Viewport height (default 800)" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "print_pdf",
                "description": "Print a public URL to PDF via headless Chrome/Edge; saves into sandbox lab/pdfs/.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "save_note",
                "description": "Save a markdown/text research note into the sandbox lab folder.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Note filename, e.g. agents.md" },
                        "content": { "type": "string" }
                    },
                    "required": ["name", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_profile",
                "description": "Read durable user profile: name, language, timezone, preferences, facts.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "remember_fact",
                "description": "Store a short durable fact about the user (preferences, favorites, etc.).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "fact": { "type": "string" }
                    },
                    "required": ["fact"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "Delete a sandbox file. Requires user confirmation before it runs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_maps() {
        assert!(matches!(AgentKind::parse("none"), AgentKind::None));
        assert!(matches!(AgentKind::parse("opencode"), AgentKind::Internal));
    }

    #[test]
    fn tools_module_linked() {
        assert!((simple_eval("2+2").unwrap() - 4.0).abs() < 1e-9);
    }
}
