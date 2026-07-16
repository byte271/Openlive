mod agent_class;
mod agent_client;
mod agent_pool;
mod hybrid;
mod knowledge;
mod llm_bridge;
mod llm_catalog;
mod mcp_client;
mod memory_store;
mod mock;
mod moshi;
mod openai_compatible;
mod openai_compatible_streaming;
mod openai_realtime;
mod openai_realtime_wire;
mod headless_browser;
mod pending_actions;
mod piper_tts;
mod pool_jobs;
mod sandbox;
mod session_context;
mod tools;
mod typo;
mod user_profile;

use async_trait::async_trait;
use openlive_protocol::{PcmAudioFrame, ProviderManifest, RealtimeEvent};
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

pub use agent_class::AgentClass;
pub use agent_client::{AgentClient, AgentError, AgentKind, AgentRequest, AgentResult};
pub use agent_pool::{
    derive_angles, pool_limits, run_pool, PoolAgentResult, PoolRequest, PoolResult, PoolTask,
    DEFAULT_POOL_SIZE, MAX_AGENTS,
};
pub use pending_actions::{
    execute_approved, list_pending, peek as peek_pending, queue_delete_file, queue_write_file,
    reject as reject_pending, PendingAction, PendingKind,
};
pub use pool_jobs::{
    get_status as pool_job_status, run_pool_tracked, start_pool_job, PoolJobStatus,
};
pub use session_context::{
    append_and_context as session_append_context, clear_session as clear_session_context,
    context_only as session_context_only, session_stats,
};
pub use user_profile::{
    add_fact as profile_add_fact, clear_facts as profile_clear_facts, clear_profile,
    export_profile_json, load_profile, move_fact as profile_move_fact, patch_profile,
    profile_context_line, profile_file_path, profile_setup_hints,
    remove_fact_at as profile_remove_fact_at, remove_fact_text as profile_remove_fact_text,
    reorder_facts as profile_reorder_facts, save_profile, set_display_name,
    set_preferred_language, update_fact_at as profile_update_fact_at, UserProfile,
};
pub use headless_browser::{
    find_browser_binary, headless_browser_status, headless_browse, headless_pdf,
    headless_screenshot, list_lab_media, read_lab_media_base64, HeadlessBrowserStatus,
    HeadlessPdfResult, HeadlessScreenshotResult, LabMediaItem,
};
pub use hybrid::HybridStreamingProvider;
pub use knowledge::{needs_deep_cognition, KnowledgeChunk, KnowledgeError, KnowledgeStore};
pub use llm_bridge::{LlmBridge, LlmError, LlmSettings};
pub use llm_catalog::{find_provider, llm_provider_catalog, LlmProviderPreset};
pub use mcp_client::{McpClient, McpError, McpTool, McpToolResult};
pub use memory_store::{
    append_memory, clear_memory, export_memory_json, load_memory, memory_file_path, MemoryDoc,
    MemoryEntry,
};
pub use mock::{preview_voice_pcm, MockDuplexProvider, VOICE_PRESETS};
pub use moshi::{MoshiConfig, MoshiProvider};
pub use openai_compatible::{OpenAiCompatibleConfig, OpenAiCompatibleProvider};
pub use openai_realtime::{OpenAiRealtimeConfig, OpenAiRealtimeProvider};
pub use piper_tts::{piper_data_dir, piper_status, piper_synthesize, PiperStatus, DEFAULT_PIPER_VOICE};
pub use sandbox::{
    delete_file as sandbox_delete_file, ensure_sandbox, list_files as sandbox_list_files,
    read_file as sandbox_read_file, sandbox_status, write_file as sandbox_write_file, SandboxStatus,
};
pub use tools::{
    browse_site, browse_url, save_lab_note, try_builtin_tools, web_search, web_search_with_sources,
    Citation,
};
pub use typo::correct_typos;

#[derive(Debug, Clone)]
pub struct ProviderSessionRequest {
    pub session_id: Uuid,
}

#[derive(Debug, Clone)]
pub enum ProviderInput {
    AudioFrame {
        media_time_us: u64,
        frame: PcmAudioFrame,
    },
    CommitResponse {
        generation_id: Uuid,
        conversation_version: u64,
        media_time_us: u64,
        prompt_hint: String,
    },
    CancelGeneration {
        generation_id: Uuid,
    },
    Close,
}

#[derive(Debug, Clone)]
pub struct ProviderEmission {
    pub generation_id: Option<Uuid>,
    pub media_offset_us: u64,
    pub output: ProviderOutput,
}

#[derive(Debug, Clone)]
pub enum ProviderOutput {
    Event(RealtimeEvent),
    Audio(PcmAudioFrame),
}

pub struct ProviderSession {
    input: mpsc::Sender<ProviderInput>,
    output: mpsc::Receiver<ProviderEmission>,
}

impl ProviderSession {
    #[must_use]
    pub fn new(
        input: mpsc::Sender<ProviderInput>,
        output: mpsc::Receiver<ProviderEmission>,
    ) -> Self {
        Self { input, output }
    }

    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        mpsc::Sender<ProviderInput>,
        mpsc::Receiver<ProviderEmission>,
    ) {
        (self.input, self.output)
    }
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider is unavailable: {0}")]
    Unavailable(String),
    #[error("provider rejected the request: {0}")]
    Rejected(String),
    #[error("provider configuration is invalid: {0}")]
    InvalidConfiguration(String),
}

#[async_trait]
pub trait RealtimeProvider: Send + Sync {
    fn manifest(&self) -> ProviderManifest;

    async fn open_session(
        &self,
        request: ProviderSessionRequest,
    ) -> Result<ProviderSession, ProviderError>;

    async fn create_client_secret(&self) -> Result<Option<String>, ProviderError> {
        Ok(None)
    }
}
