mod mock;
mod openai_compatible;
mod openai_compatible_streaming;
mod openai_realtime;
mod openai_realtime_wire;

use async_trait::async_trait;
use openlive_protocol::{InputAudioFrame, ProviderManifest, RealtimeEvent};
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

pub use mock::MockDuplexProvider;
pub use openai_compatible::{OpenAiCompatibleConfig, OpenAiCompatibleProvider};
pub use openai_realtime::{OpenAiRealtimeConfig, OpenAiRealtimeProvider};

#[derive(Debug, Clone)]
pub struct ProviderSessionRequest {
    pub session_id: Uuid,
}

#[derive(Debug, Clone)]
pub enum ProviderInput {
    AudioFrame {
        media_time_us: u64,
        frame: InputAudioFrame,
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
    pub event: RealtimeEvent,
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
}
