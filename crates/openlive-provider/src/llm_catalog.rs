//! Built-in LLM provider catalog (OpenAI-compatible chat endpoints).
//!
//! NVIDIA NIM free-tier + ten common hosts + custom. Keys never leave the
//! operator machine except when the gateway proxies chat/agent calls.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderPreset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub base_url: String,
    pub default_model: String,
    pub models: Vec<String>,
    /// True when a free / trial tier is commonly available.
    pub free_tier: bool,
    pub docs_url: String,
    pub auth_hint: String,
}

/// NVIDIA NIM + 10 hosts + custom entry (12 total selectable options).
#[must_use]
pub fn llm_provider_catalog() -> Vec<LlmProviderPreset> {
    vec![
        LlmProviderPreset {
            id: "nvidia".into(),
            name: "NVIDIA NIM".into(),
            description: "Free API key via build.nvidia.com — OpenAI-compatible chat.".into(),
            base_url: "https://integrate.api.nvidia.com/v1".into(),
            default_model: "meta/llama-3.1-8b-instruct".into(),
            models: vec![
                "meta/llama-3.1-8b-instruct".into(),
                "meta/llama-3.3-70b-instruct".into(),
                "google/gemma-2-9b-it".into(),
                "mistralai/mistral-7b-instruct-v0.3".into(),
                "microsoft/phi-3-mini-128k-instruct".into(),
            ],
            free_tier: true,
            docs_url: "https://build.nvidia.com/".into(),
            auth_hint: "API key from build.nvidia.com (Bearer)".into(),
        },
        LlmProviderPreset {
            id: "groq".into(),
            name: "Groq".into(),
            description: "Fast open models (Llama, Gemma) via GroqCloud.".into(),
            base_url: "https://api.groq.com/openai/v1".into(),
            default_model: "llama-3.3-70b-versatile".into(),
            models: vec![
                "llama-3.3-70b-versatile".into(),
                "llama-3.1-8b-instant".into(),
                "gemma2-9b-it".into(),
            ],
            free_tier: true,
            docs_url: "https://console.groq.com/".into(),
            auth_hint: "Groq API key".into(),
        },
        LlmProviderPreset {
            id: "openrouter".into(),
            name: "OpenRouter".into(),
            description: "Many open models behind one OpenAI-compatible API.".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            default_model: "meta-llama/llama-3.1-8b-instruct:free".into(),
            models: vec![
                "meta-llama/llama-3.1-8b-instruct:free".into(),
                "google/gemma-2-9b-it:free".into(),
                "mistralai/mistral-7b-instruct:free".into(),
            ],
            free_tier: true,
            docs_url: "https://openrouter.ai/".into(),
            auth_hint: "OpenRouter API key".into(),
        },
        LlmProviderPreset {
            id: "together".into(),
            name: "Together AI".into(),
            description: "Open-weight models hosted by Together.".into(),
            base_url: "https://api.together.xyz/v1".into(),
            default_model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo".into(),
            models: vec![
                "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo".into(),
                "mistralai/Mixtral-8x7B-Instruct-v0.1".into(),
            ],
            free_tier: false,
            docs_url: "https://www.together.ai/".into(),
            auth_hint: "Together API key".into(),
        },
        LlmProviderPreset {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            description: "DeepSeek chat models (OpenAI-compatible).".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            default_model: "deepseek-chat".into(),
            models: vec!["deepseek-chat".into(), "deepseek-reasoner".into()],
            free_tier: false,
            docs_url: "https://platform.deepseek.com/".into(),
            auth_hint: "DeepSeek API key".into(),
        },
        LlmProviderPreset {
            id: "fireworks".into(),
            name: "Fireworks".into(),
            description: "Fast inference for open models.".into(),
            base_url: "https://api.fireworks.ai/inference/v1".into(),
            default_model: "accounts/fireworks/models/llama-v3p1-8b-instruct".into(),
            models: vec![
                "accounts/fireworks/models/llama-v3p1-8b-instruct".into(),
                "accounts/fireworks/models/mixtral-8x7b-instruct".into(),
            ],
            free_tier: false,
            docs_url: "https://fireworks.ai/".into(),
            auth_hint: "Fireworks API key".into(),
        },
        LlmProviderPreset {
            id: "mistral".into(),
            name: "Mistral".into(),
            description: "Mistral large / small via official API.".into(),
            base_url: "https://api.mistral.ai/v1".into(),
            default_model: "mistral-small-latest".into(),
            models: vec![
                "mistral-small-latest".into(),
                "mistral-large-latest".into(),
                "open-mistral-nemo".into(),
            ],
            free_tier: false,
            docs_url: "https://console.mistral.ai/".into(),
            auth_hint: "Mistral API key".into(),
        },
        LlmProviderPreset {
            id: "ollama".into(),
            name: "Ollama (local)".into(),
            description: "Fully local open models via Ollama OpenAI shim.".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            default_model: "llama3.2".into(),
            models: vec!["llama3.2".into(), "mistral".into(), "qwen2.5".into(), "gemma2".into()],
            free_tier: true,
            docs_url: "https://ollama.com/".into(),
            auth_hint: "Usually no key (local)".into(),
        },
        LlmProviderPreset {
            id: "openai".into(),
            name: "OpenAI".into(),
            description: "OpenAI chat completions (paid).".into(),
            base_url: "https://api.openai.com/v1".into(),
            default_model: "gpt-4o-mini".into(),
            models: vec!["gpt-4o-mini".into(), "gpt-4o".into(), "gpt-4.1-mini".into()],
            free_tier: false,
            docs_url: "https://platform.openai.com/".into(),
            auth_hint: "OpenAI API key (sk-…)".into(),
        },
        LlmProviderPreset {
            id: "cerebras".into(),
            name: "Cerebras".into(),
            description: "Very fast Llama inference.".into(),
            base_url: "https://api.cerebras.ai/v1".into(),
            default_model: "llama3.1-8b".into(),
            models: vec!["llama3.1-8b".into(), "llama-3.3-70b".into()],
            free_tier: true,
            docs_url: "https://inference-docs.cerebras.ai/".into(),
            auth_hint: "Cerebras API key".into(),
        },
        LlmProviderPreset {
            id: "sambanova".into(),
            name: "SambaNova".into(),
            description: "SambaNova Cloud open models.".into(),
            base_url: "https://api.sambanova.ai/v1".into(),
            default_model: "Meta-Llama-3.1-8B-Instruct".into(),
            models: vec![
                "Meta-Llama-3.1-8B-Instruct".into(),
                "Meta-Llama-3.3-70B-Instruct".into(),
            ],
            free_tier: true,
            docs_url: "https://cloud.sambanova.ai/".into(),
            auth_hint: "SambaNova API key".into(),
        },
        LlmProviderPreset {
            id: "custom".into(),
            name: "Custom".into(),
            description: "Any OpenAI-compatible base URL. Enter base URL, then pick or type a model id.".into(),
            base_url: "http://127.0.0.1:8000/v1".into(),
            default_model: "default".into(),
            models: vec![],
            free_tier: true,
            docs_url: "".into(),
            auth_hint: "Provider-specific API key if required".into(),
        },
    ]
}

#[must_use]
pub fn find_provider(id: &str) -> Option<LlmProviderPreset> {
    llm_provider_catalog()
        .into_iter()
        .find(|p| p.id.eq_ignore_ascii_case(id))
}
