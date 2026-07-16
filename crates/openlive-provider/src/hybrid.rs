//! Hybrid streaming provider: fast conversational path + deep cascade path.
//!
//! Mirrors GPT-Live's dual-plane pattern:
//! - **Fast**: local mock duplex (low-latency formant speech) for short turns
//! - **Deep**: OpenAI-compatible cascade when the turn looks complex
//!
//! When no deep provider is configured, behaves like the mock duplex provider.

use async_trait::async_trait;
use openlive_protocol::{
    AudioCapabilities, ControlCapabilities, DuplexCapabilities, LicenseClass, Modality,
    ModalityCapabilities, ProviderClass, ProviderLimits, ProviderManifest,
};
use tokio::sync::mpsc;
use crate::{
    knowledge::needs_deep_cognition,
    mock::MockDuplexProvider,
    openai_compatible::OpenAiCompatibleProvider,
    ProviderEmission, ProviderError, ProviderInput, ProviderSession, ProviderSessionRequest,
    RealtimeProvider,
};

#[derive(Clone)]
pub struct HybridStreamingProvider {
    fast: MockDuplexProvider,
    deep: Option<OpenAiCompatibleProvider>,
}

impl HybridStreamingProvider {
    #[must_use]
    pub fn mock_only() -> Self {
        Self {
            fast: MockDuplexProvider::default(),
            deep: None,
        }
    }

    #[must_use]
    pub fn with_deep(deep: OpenAiCompatibleProvider) -> Self {
        Self {
            fast: MockDuplexProvider::default(),
            deep: Some(deep),
        }
    }
}

#[async_trait]
impl RealtimeProvider for HybridStreamingProvider {
    fn manifest(&self) -> ProviderManifest {
        let base = self.fast.manifest();
        ProviderManifest {
            id: "openlive/hybrid-streaming".to_owned(),
            adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_class: ProviderClass::HybridStreaming,
            license_class: LicenseClass::Redistributable,
            modalities: ModalityCapabilities {
                input: vec![Modality::Audio, Modality::Text],
                output: vec![Modality::Audio, Modality::Text, Modality::State],
            },
            duplex: DuplexCapabilities {
                continuous_input_while_output: true,
                native_turn_policy: false,
                native_barge_in: true,
                state_tokens: true,
            },
            audio: AudioCapabilities {
                input_sample_rates: base.audio.input_sample_rates,
                output_sample_rates: base.audio.output_sample_rates,
                frame_ms: base.audio.frame_ms,
            },
            control: ControlCapabilities {
                text_injection: true,
                context_update: true,
                voice_conditioning: false,
                cancel_generation: true,
                resume_generation: false,
            },
            limits: ProviderLimits {
                max_session_seconds: 7_200,
                required_gpu_memory_gb: None,
            },
        }
    }

    async fn open_session(
        &self,
        request: ProviderSessionRequest,
    ) -> Result<ProviderSession, ProviderError> {
        let fast_session = self.fast.open_session(request.clone()).await?;
        let deep_session = match &self.deep {
            Some(deep) => Some(deep.open_session(request).await?),
            None => None,
        };

        let (input_tx, mut input_rx) = mpsc::channel::<ProviderInput>(128);
        let (output_tx, output_rx) = mpsc::channel::<ProviderEmission>(128);

        let (fast_in, mut fast_out) = fast_session.into_parts();
        let (deep_in, mut deep_out) = match deep_session {
            Some(session) => {
                let (din, dout) = session.into_parts();
                (Some(din), Some(dout))
            }
            None => (None, None),
        };

        // Merge child provider emissions.
        let merge_tx = output_tx.clone();
        tokio::spawn(async move {
            let mut fast_done = false;
            let mut deep_done = deep_out.is_none();
            while !fast_done || !deep_done {
                tokio::select! {
                    msg = fast_out.recv(), if !fast_done => {
                        match msg {
                            Some(emission) => {
                                if merge_tx.send(emission).await.is_err() {
                                    return;
                                }
                            }
                            None => fast_done = true,
                        }
                    }
                    msg = async {
                        match deep_out.as_mut() {
                            Some(rx) => rx.recv().await,
                            None => {
                                std::future::pending::<Option<ProviderEmission>>().await
                            }
                        }
                    }, if !deep_done => {
                        match msg {
                            Some(emission) => {
                                if merge_tx.send(emission).await.is_err() {
                                    return;
                                }
                            }
                            None => deep_done = true,
                        }
                    }
                }
            }
        });

        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                match input {
                    ProviderInput::AudioFrame {
                        media_time_us,
                        frame,
                    } => {
                        let _ = fast_in
                            .send(ProviderInput::AudioFrame {
                                media_time_us,
                                frame: frame.clone(),
                            })
                            .await;
                        if let Some(ref din) = deep_in {
                            let _ = din
                                .send(ProviderInput::AudioFrame {
                                    media_time_us,
                                    frame,
                                })
                                .await;
                        }
                    }
                    ProviderInput::CommitResponse {
                        generation_id,
                        conversation_version,
                        media_time_us,
                        prompt_hint,
                    } => {
                        let use_deep = deep_in.is_some() && needs_deep_cognition(&prompt_hint);
                        let commit = ProviderInput::CommitResponse {
                            generation_id,
                            conversation_version,
                            media_time_us,
                            prompt_hint,
                        };
                        if use_deep {
                            let _ = fast_in
                                .send(ProviderInput::CancelGeneration { generation_id })
                                .await;
                            if let Some(ref din) = deep_in {
                                let _ = din.send(commit).await;
                            }
                        } else {
                            if let Some(ref din) = deep_in {
                                let _ = din
                                    .send(ProviderInput::CancelGeneration { generation_id })
                                    .await;
                            }
                            let _ = fast_in.send(commit).await;
                        }
                    }
                    ProviderInput::CancelGeneration { generation_id } => {
                        let _ = fast_in
                            .send(ProviderInput::CancelGeneration { generation_id })
                            .await;
                        if let Some(ref din) = deep_in {
                            let _ = din
                                .send(ProviderInput::CancelGeneration { generation_id })
                                .await;
                        }
                    }
                    ProviderInput::Close => {
                        let _ = fast_in.send(ProviderInput::Close).await;
                        if let Some(ref din) = deep_in {
                            let _ = din.send(ProviderInput::Close).await;
                        }
                        break;
                    }
                }
            }
        });

        Ok(ProviderSession::new(input_tx, output_rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn hybrid_manifest_is_hybrid_class() {
        let provider = HybridStreamingProvider::mock_only();
        assert_eq!(
            provider.manifest().provider_class,
            ProviderClass::HybridStreaming
        );
    }

    #[tokio::test]
    async fn hybrid_opens_session() {
        let provider = HybridStreamingProvider::mock_only();
        let session = provider
            .open_session(ProviderSessionRequest {
                session_id: Uuid::new_v4(),
            })
            .await
            .expect("session");
        let (input, _output) = session.into_parts();
        input
            .send(ProviderInput::CommitResponse {
                generation_id: Uuid::new_v4(),
                conversation_version: 1,
                media_time_us: 0,
                prompt_hint: "hi".into(),
            })
            .await
            .expect("commit");
    }
}
