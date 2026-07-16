//! Shared OpenAI-compatible chat client for voice replies and the internal agent.

use std::sync::RwLock;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::llm_catalog::find_provider;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("llm http: {0}")]
    Http(#[from] reqwest::Error),
    /// Upstream model API returned a non-success HTTP status (or invalid body).
    #[error("llm rejected ({status}): {body}")]
    Rejected {
        status: u16,
        body: String,
    },
    #[error("llm config: {0}")]
    Config(String),
}

impl LlmError {
    /// HTTP status when the upstream model rejected the call (0 for transport/config).
    #[must_use]
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Rejected { status, .. } => *status,
            Self::Http(e) => e.status().map(|s| s.as_u16()).unwrap_or(0),
            Self::Config(_) => 0,
        }
    }

    pub fn rejected(status: u16, body: impl Into<String>) -> Self {
        Self::Rejected {
            status,
            body: body.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSettings {
    pub provider_id: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub system_prompt: String,
}

impl Default for LlmSettings {
    fn default() -> Self {
        // NVIDIA free-tier defaults; works once the user pastes a key.
        Self {
            provider_id: "nvidia".into(),
            base_url: "https://integrate.api.nvidia.com/v1".into(),
            api_key: None,
            model: "meta/llama-3.1-8b-instruct".into(),
            system_prompt: "You are OpenLive, a voice assistant. Answer the user in 1-2 short spoken sentences. Only the final answer — never plan, never think aloud, never mention tools, prompts, or reasoning. Plain text only.".into(),
        }
    }
}

impl LlmSettings {
    #[must_use]
    pub fn from_provider_id(provider_id: &str) -> Self {
        let mut s = Self::default();
        if let Some(p) = find_provider(provider_id) {
            s.provider_id = p.id;
            s.base_url = p.base_url;
            s.model = p.default_model;
        } else {
            s.provider_id = provider_id.to_owned();
        }
        s
    }

    #[must_use]
    pub fn configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    /// True when we can attempt a live chat call (key optional for Ollama/local).
    #[must_use]
    pub fn can_chat(&self) -> bool {
        self.configured()
            && (self.api_key.as_ref().is_some_and(|k| !k.is_empty())
                || self.provider_id == "ollama"
                || self.base_url.contains("127.0.0.1")
                || self.base_url.contains("localhost"))
    }
}

#[derive(Clone)]
pub struct LlmBridge {
    client: Client,
    settings: std::sync::Arc<RwLock<LlmSettings>>,
    /// Rolling short-term dialogue for multi-turn voice.
    history: std::sync::Arc<RwLock<Vec<Value>>>,
}

const MAX_HISTORY_MESSAGES: usize = 12;

impl LlmBridge {
    /// # Errors
    pub fn new() -> Result<Self, LlmError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(18))
            .build()?;
        Ok(Self {
            client,
            settings: std::sync::Arc::new(RwLock::new(LlmSettings::default())),
            history: std::sync::Arc::new(RwLock::new(Vec::new())),
        })
    }

    #[must_use]
    pub fn settings(&self) -> LlmSettings {
        self.settings.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn update_settings(&self, partial: LlmSettings) {
        if let Ok(mut g) = self.settings.write() {
            *g = partial;
        }
    }

    pub fn patch_settings<F: FnOnce(&mut LlmSettings)>(&self, f: F) {
        if let Ok(mut g) = self.settings.write() {
            f(&mut g);
        }
    }

    pub fn clear_history(&self) {
        if let Ok(mut h) = self.history.write() {
            h.clear();
        }
    }

    fn push_history(&self, role: &str, content: &str) {
        if let Ok(mut h) = self.history.write() {
            h.push(json!({"role": role, "content": content}));
            while h.len() > MAX_HISTORY_MESSAGES {
                h.remove(0);
            }
        }
    }

    /// Simple chat completion (no tools).
    pub async fn chat(&self, user_text: &str) -> Result<String, LlmError> {
        let s = self.settings();
        if !s.can_chat() {
            return Err(LlmError::Config(
                "LLM not configured — set provider, model, and API key in Settings".into(),
            ));
        }
        let mut messages = vec![json!({"role": "system", "content": s.system_prompt})];
        if let Ok(h) = self.history.read() {
            messages.extend(h.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": user_text}));
        let reply = self.chat_messages(&messages, None, 256).await?;
        self.push_history("user", user_text);
        self.push_history("assistant", &reply);
        Ok(reply)
    }

    /// Short spoken replies — lower max tokens for latency.
    pub async fn chat_voice(&self, user_text: &str) -> Result<String, LlmError> {
        let s = self.settings();
        if !s.can_chat() {
            return Err(LlmError::Config("LLM not configured".into()));
        }
        // Strip fillers before model so "um uh what's the weather" is clean.
        let cleaned = strip_fillers_for_llm(user_text);
        if cleaned.len() < 2 {
            return Ok("Mm-hmm.".into());
        }
        let system = "You are OpenLive, a capable live voice assistant (similar fluidity to GPT voice mode). Reply in 1–3 short spoken sentences. Be warm, clear, and competent. Match the user's language (Chinese↔Chinese, English↔English). If they ask who you are: you are OpenLive, a local voice assistant that can chat, search, do math, and tell time. Never think aloud, never plan your reply, never mention tools or prompts. Just talk naturally.";
        let mut messages = vec![json!({"role": "system", "content": system})];
        if let Ok(h) = self.history.read() {
            messages.extend(h.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": cleaned}));
        // Enough tokens for a natural reply without dumping essays.
        let reply = self.chat_messages(&messages, None, 160).await?;
        self.push_history("user", &cleaned);
        self.push_history("assistant", &reply);
        Ok(reply)
    }

    pub async fn chat_messages(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        max_tokens: u32,
    ) -> Result<String, LlmError> {
        let s = self.settings();
        let url = chat_url(&s.base_url);
        // Some NIM models reject max_tokens or need stream:false explicitly.
        let mut body = json!({
            "model": s.model,
            "messages": messages,
            "temperature": 0.5,
            "max_tokens": max_tokens.max(16),
            "stream": false,
        });
        if let Some(t) = tools {
            if !t.is_empty() {
                body["tools"] = Value::Array(t.to_vec());
                body["tool_choice"] = json!("auto");
            }
        }
        let mut req = self
            .client
            .post(&url)
            .header("Accept", "application/json")
            .json(&body);
        if let Some(key) = s.api_key.as_ref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        // NVIDIA catalog sometimes wants this header.
        if s.base_url.contains("nvidia.com") {
            req = req.header("User-Agent", "OpenLive/26.7.15");
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(LlmError::rejected(
                status.as_u16(),
                format!("{}: {}", status, truncate(&text, 280)),
            ));
        }
        let value: Value = serde_json::from_str(&text).map_err(|e| {
            LlmError::rejected(
                502,
                format!("invalid json: {e}; body={}", truncate(&text, 240)),
            )
        })?;
        if let Some(content) = extract_content(&value) {
            return Ok(content);
        }
        // Retry once without temperature for picky models.
        Err(LlmError::rejected(
            502,
            format!(
                "empty model content for '{}'. Try meta/llama-3.1-8b-instruct. body={}",
                s.model,
                truncate(&text, 360)
            ),
        ))
    }

    /// Full message object for tool loops.
    pub async fn chat_raw(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
    ) -> Result<Value, LlmError> {
        let s = self.settings();
        let url = chat_url(&s.base_url);
        let mut body = json!({
            "model": s.model,
            "messages": messages,
            "temperature": 0.35,
            "max_tokens": 512,
        });
        if let Some(t) = tools {
            if !t.is_empty() {
                body["tools"] = Value::Array(t.to_vec());
                body["tool_choice"] = json!("auto");
            }
        }
        let mut req = self.client.post(&url).json(&body);
        if let Some(key) = s.api_key.as_ref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Many free/open models reject tools — surface clearly.
            return Err(LlmError::rejected(
                status.as_u16(),
                format!("{status}: {}", truncate(&text, 400)),
            ));
        }
        serde_json::from_str(&text)
            .map_err(|e| LlmError::rejected(502, e.to_string()))
    }

    /// List models from the configured (or override) base URL.
    pub async fn list_models(
        &self,
        base_url: Option<&str>,
        api_key: Option<&str>,
    ) -> Result<Vec<String>, LlmError> {
        let s = self.settings();
        let base = base_url.unwrap_or(&s.base_url).trim_end_matches('/');
        let url = if base.ends_with("/v1") {
            format!("{base}/models")
        } else {
            format!("{base}/v1/models")
        };
        let mut req = self.client.get(&url);
        let key = api_key
            .map(str::to_owned)
            .or_else(|| s.api_key.clone())
            .filter(|k| !k.is_empty());
        if let Some(k) = key {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(LlmError::rejected(
                status.as_u16(),
                format!("{status}: {}", truncate(&text, 400)),
            ));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| LlmError::rejected(502, e.to_string()))?;
        let mut ids = Vec::new();
        if let Some(arr) = value.get("data").and_then(Value::as_array) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    ids.push(id.to_owned());
                }
            }
        }
        ids.sort();
        Ok(ids)
    }
}

fn strip_fillers_for_llm(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let fillers = [
        "you know",
        "i mean",
        "sort of",
        "kind of",
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
    ];
    let mut out = lower;
    for f in fillers {
        out = out.replace(f, " ");
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn chat_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_owned()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.replace('\n', " ");
    if t.len() <= max {
        t
    } else {
        format!("{}…", &t[..max])
    }
}

fn extract_content(value: &Value) -> Option<String> {
    // ONLY user-facing answer text. Never return reasoning_content / thinking —
    // those are internal and must not be spoken or shown to the human.
    // OpenAI chat: choices[0].message.content (string)
    if let Some(c) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        let t = strip_internal_thinking(c);
        if !t.is_empty() {
            return Some(t);
        }
    }
    // Multimodal / NVIDIA / some OSS: content is an array of parts
    if let Some(arr) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_array)
    {
        let mut out = String::new();
        for part in arr {
            // Skip explicit reasoning/thinking parts.
            let ptype = part.get("type").and_then(Value::as_str).unwrap_or("");
            if ptype.contains("reason") || ptype.contains("think") {
                continue;
            }
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                out.push_str(t);
            } else if let Some(t) = part.as_str() {
                out.push_str(t);
            }
        }
        let t = strip_internal_thinking(&out);
        if !t.is_empty() {
            return Some(t);
        }
    }
    // Safe non-reasoning fallbacks only (never reasoning_content / reasoning).
    for path in [
        "/choices/0/text",
        "/choices/0/delta/content",
        "/output_text",
        "/response",
        "/content",
        "/text",
        "/output",
    ] {
        if let Some(c) = value.pointer(path).and_then(Value::as_str) {
            let t = strip_internal_thinking(c);
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    // Nested choices[0].message as string (rare)
    if let Some(c) = value
        .pointer("/choices/0/message")
        .and_then(Value::as_str)
    {
        let t = strip_internal_thinking(c);
        if !t.is_empty() {
            return Some(t);
        }
    }
    // Refusal is user-facing (not private thought).
    if let Some(r) = value
        .pointer("/choices/0/message/refusal")
        .and_then(Value::as_str)
    {
        let t = r.trim();
        if !t.is_empty() {
            return Some(t.to_owned());
        }
    }
    None
}

/// Drop private model thought blocks; keep only the final answer for humans.
fn strip_internal_thinking(text: &str) -> String {
    let mut t = text.to_owned();
    // XML-style think blocks (DeepSeek-R1, QwQ, etc.)
    for (open, close) in [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
        ("<reasoning>", "</reasoning>"),
        ("<reflection>", "</reflection>"),
    ] {
        while let Some(start) = t.to_ascii_lowercase().find(open) {
            let after_open = start + open.len();
            if let Some(rel) = t[after_open..].to_ascii_lowercase().find(close) {
                let end = after_open + rel + close.len();
                t = format!("{}{}", &t[..start], &t[end..]);
            } else {
                // Unclosed think block → drop everything from open tag.
                t = t[..start].to_owned();
                break;
            }
        }
    }
    // Markdown-ish "Thought:" / "Reasoning:" preambles before the real answer.
    let lower = t.to_ascii_lowercase();
    for marker in [
        "\nfinal answer:",
        "\nanswer:",
        "\nresponse:",
        "\nassistant:",
    ] {
        if let Some(i) = lower.find(marker) {
            t = t[i + marker.len()..].to_owned();
            break;
        }
    }
    t.trim().to_owned()
}

/// Extract tool_calls from a chat completion message if present.
#[must_use]
pub fn message_tool_calls(message: &Value) -> Vec<Value> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[must_use]
pub fn choice_message(value: &Value) -> Option<Value> {
    value.pointer("/choices/0/message").cloned()
}
