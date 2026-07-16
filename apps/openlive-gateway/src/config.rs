use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use clap::{Parser, ValueEnum};
use openlive_provider::{
    HybridStreamingProvider, LlmBridge, MockDuplexProvider, MoshiConfig, MoshiProvider,
    OpenAiCompatibleConfig, OpenAiCompatibleProvider, OpenAiRealtimeConfig,
    OpenAiRealtimeProvider, RealtimeProvider,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ProviderKind {
    Mock,
    OpenaiCompatible,
    OpenaiRealtime,
    /// Kyutai Moshi–compatible native duplex WebSocket worker.
    Moshi,
    /// Fast mock duplex + deep cascade handoff for complex turns.
    Hybrid,
}

#[derive(Debug, Parser)]
#[command(name = "openlive-gateway")]
#[command(about = "OpenLive gateway — model-neutral full-duplex voice runtime")]
pub(crate) struct Args {
    #[arg(long, default_value = "127.0.0.1:8787")]
    pub listen: SocketAddr,
    #[arg(long, default_value = "apps/openlive-gateway/web")]
    pub web_dir: PathBuf,
    #[arg(long, value_enum, default_value_t = ProviderKind::Mock)]
    provider: ProviderKind,
    /// OpenAI-compatible base URL (ASR + chat + TTS). Point at LocalAI,
    /// openedai-speech, or any cascade that speaks the OpenAI REST shape.
    #[arg(long, default_value = "http://127.0.0.1:8000/v1")]
    model_base_url: String,
    #[arg(long, default_value = "whisper-1")]
    asr_model: String,
    #[arg(long, default_value = "default")]
    llm_model: String,
    #[arg(long, default_value = "tts-1")]
    tts_model: String,
    /// Preferred TTS voice id. Default is a Piper open voice id used by
    /// openedai-speech / LocalAI; use `alloy` for hosted OpenAI-compatible APIs.
    #[arg(long, default_value = "en_US-lessac-medium")]
    voice: String,
    #[arg(long, default_value = "wss://api.openai.com/v1/realtime")]
    realtime_url: String,
    #[arg(long, default_value = "gpt-4o-realtime-preview")]
    realtime_model: String,
    /// Moshi / native duplex WebSocket URL.
    #[arg(long, default_value = "ws://127.0.0.1:8998/api/chat")]
    moshi_url: String,
    #[arg(long, default_value = "OPENLIVE_MODEL_API_KEY")]
    api_key_env: String,
    /// Soft task deadline in milliseconds when the client omits one.
    /// Use 0 for no gateway-imposed default (client must supply deadlines).
    #[arg(long, default_value_t = 45_000)]
    pub task_deadline_ms: u64,
    /// Optional developer API key. When set, mutating routes require
    /// `Authorization: Bearer <key>` or `X-OpenLive-Key`. Also read from
    /// `OPENLIVE_API_KEY` when the flag is omitted.
    #[arg(long)]
    pub api_key: Option<String>,
    /// Directory for durable session JSONL state (events + tasks). Empty disables.
    #[arg(long, default_value = "data/openlive-sessions")]
    pub data_dir: PathBuf,
    /// Disable writing session state under `data_dir`.
    #[arg(long, default_value_t = false)]
    pub no_persist: bool,
    /// Enable streaming safety holdback on assistant text (default on).
    #[arg(long, default_value_t = true)]
    pub safety: bool,
    /// Optional MCP HTTP JSON-RPC endpoint for tools/list and tools/call.
    #[arg(long)]
    pub mcp_url: Option<String>,
    /// Optional deeper LLM model id for complex turns (cascade provider).
    #[arg(long)]
    pub deep_llm_model: Option<String>,
    /// Directory of `.md`/`.txt` notes injected as retrieval context at commit.
    #[arg(long)]
    pub knowledge_dir: Option<PathBuf>,
}

impl Args {
    /// Resolves the API key from CLI or environment.
    #[must_use]
    pub fn resolved_api_key(&self) -> Option<String> {
        self.api_key
            .clone()
            .or_else(|| env::var("OPENLIVE_API_KEY").ok())
            .filter(|value| !value.is_empty())
    }

    /// Builds the configured provider without exposing credentials.
    ///
    /// # Errors
    ///
    /// Returns an error when a provider configuration or client cannot be
    /// initialized.
    pub(crate) fn build_provider(
        &self,
        llm: Option<Arc<LlmBridge>>,
    ) -> Result<(Arc<dyn RealtimeProvider>, Option<MockDuplexProvider>), Box<dyn std::error::Error>>
    {
        match self.provider {
            ProviderKind::Mock => {
                let mock = if let Some(bridge) = llm {
                    MockDuplexProvider::with_llm(bridge)
                } else {
                    MockDuplexProvider::default()
                };
                mock.set_voice(&self.voice);
                Ok((Arc::new(mock.clone()), Some(mock)))
            }
            ProviderKind::OpenaiCompatible => {
                let provider = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
                    base_url: self.model_base_url.clone(),
                    api_key: env::var(&self.api_key_env).ok(),
                    asr_model: self.asr_model.clone(),
                    llm_model: self.llm_model.clone(),
                    deep_llm_model: self.deep_llm_model.clone(),
                    tts_model: self.tts_model.clone(),
                    voice: self.voice.clone(),
                    system_prompt: "Respond naturally and concisely for spoken conversation."
                        .to_owned(),
                    knowledge_dir: self.knowledge_dir.clone(),
                })?;
                Ok((Arc::new(provider), None))
            }
            ProviderKind::OpenaiRealtime => {
                let provider = OpenAiRealtimeProvider::new(OpenAiRealtimeConfig {
                    url: self.realtime_url.clone(),
                    api_key: env::var(&self.api_key_env).ok(),
                    model: self.realtime_model.clone(),
                    voice: self.voice.clone(),
                    instructions: "Respond naturally and concisely for spoken conversation."
                        .to_owned(),
                })?;
                Ok((Arc::new(provider), None))
            }
            ProviderKind::Moshi => {
                let provider = MoshiProvider::new(MoshiConfig {
                    url: self.moshi_url.clone(),
                    voice: self.voice.clone(),
                })?;
                Ok((Arc::new(provider), None))
            }
            ProviderKind::Hybrid => {
                // Prefer LLM-backed mock for fast path when bridge is available.
                if let Some(bridge) = llm {
                    let mock = MockDuplexProvider::with_llm(bridge);
                    mock.set_voice(&self.voice);
                    Ok((Arc::new(mock.clone()), Some(mock)))
                } else {
                    let deep = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
                        base_url: self.model_base_url.clone(),
                        api_key: env::var(&self.api_key_env).ok(),
                        asr_model: self.asr_model.clone(),
                        llm_model: self.llm_model.clone(),
                        deep_llm_model: self.deep_llm_model.clone(),
                        tts_model: self.tts_model.clone(),
                        voice: self.voice.clone(),
                        system_prompt: "Respond naturally and concisely for spoken conversation."
                            .to_owned(),
                        knowledge_dir: self.knowledge_dir.clone(),
                    })
                    .ok();
                    let provider = match deep {
                        Some(deep) => HybridStreamingProvider::with_deep(deep),
                        None => HybridStreamingProvider::mock_only(),
                    };
                    Ok((Arc::new(provider), None))
                }
            }
        }
    }
}

/// Static catalog of providers operators can select via `--provider`.
#[must_use]
pub fn provider_catalog() -> serde_json::Value {
    serde_json::json!([
        {
            "id": "mock",
            "class": "mock",
            "summary": "Offline formant duplex for demos (no external services)",
            "cli": "--provider mock"
        },
        {
            "id": "openai-compatible",
            "class": "cascade",
            "summary": "ASR→LLM→TTS cascade (LocalAI / Piper / openedai-speech)",
            "cli": "--provider openai-compatible --model-base-url http://127.0.0.1:8000/v1"
        },
        {
            "id": "openai-realtime",
            "class": "native_duplex",
            "summary": "OpenAI Realtime WebSocket (or compatible self-host)",
            "cli": "--provider openai-realtime --realtime-url wss://..."
        },
        {
            "id": "moshi",
            "class": "native_duplex",
            "summary": "Kyutai Moshi–compatible full-duplex WebSocket worker",
            "cli": "--provider moshi --moshi-url ws://127.0.0.1:8998/api/chat"
        },
        {
            "id": "hybrid",
            "class": "hybrid_streaming",
            "summary": "Fast mock path + deep cascade handoff for complex turns",
            "cli": "--provider hybrid --model-base-url http://127.0.0.1:8000/v1"
        }
    ])
}
