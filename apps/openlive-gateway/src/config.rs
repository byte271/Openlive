use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use clap::{Parser, ValueEnum};
use openlive_provider::{
    MockDuplexProvider, OpenAiCompatibleConfig, OpenAiCompatibleProvider, OpenAiRealtimeConfig,
    OpenAiRealtimeProvider, RealtimeProvider,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ProviderKind {
    Mock,
    OpenaiCompatible,
    OpenaiRealtime,
}

#[derive(Debug, Parser)]
#[command(name = "openlive-gateway")]
pub(crate) struct Args {
    #[arg(long, default_value = "127.0.0.1:8787")]
    pub listen: SocketAddr,
    #[arg(long, default_value = "apps/openlive-gateway/web")]
    pub web_dir: PathBuf,
    #[arg(long, value_enum, default_value_t = ProviderKind::Mock)]
    provider: ProviderKind,
    #[arg(long, default_value = "http://127.0.0.1:8000/v1")]
    model_base_url: String,
    #[arg(long, default_value = "whisper-1")]
    asr_model: String,
    #[arg(long, default_value = "default")]
    llm_model: String,
    #[arg(long, default_value = "tts-1")]
    tts_model: String,
    #[arg(long, default_value = "alloy")]
    voice: String,
    #[arg(long, default_value = "wss://api.openai.com/v1/realtime")]
    realtime_url: String,
    #[arg(long, default_value = "gpt-4o-realtime-preview")]
    realtime_model: String,
    #[arg(long, default_value = "OPENLIVE_MODEL_API_KEY")]
    api_key_env: String,
}

impl Args {
    /// Builds the configured provider without exposing credentials.
    ///
    /// # Errors
    ///
    /// Returns an error when a provider configuration or client cannot be
    /// initialized.
    pub(crate) fn build_provider(
        &self,
    ) -> Result<Arc<dyn RealtimeProvider>, Box<dyn std::error::Error>> {
        match self.provider {
            ProviderKind::Mock => Ok(Arc::new(MockDuplexProvider::default())),
            ProviderKind::OpenaiCompatible => {
                let provider = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
                    base_url: self.model_base_url.clone(),
                    api_key: env::var(&self.api_key_env).ok(),
                    asr_model: self.asr_model.clone(),
                    llm_model: self.llm_model.clone(),
                    tts_model: self.tts_model.clone(),
                    voice: self.voice.clone(),
                    system_prompt: "Respond naturally and concisely for spoken conversation."
                        .to_owned(),
                })?;
                Ok(Arc::new(provider))
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
                Ok(Arc::new(provider))
            }
        }
    }
}
