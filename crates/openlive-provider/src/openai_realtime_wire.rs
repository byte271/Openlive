use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header::AUTHORIZATION, HeaderValue},
};
use url::Url;

use crate::ProviderError;

const SAMPLE_RATE: u32 = 24_000;

pub(super) fn session_update_event(instructions: &str, voice: &str) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "instructions": instructions,
            "voice": voice,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "turn_detection": null
        }
    })
}

pub(super) fn response_create_event(prompt_hint: &str) -> Value {
    let mut response = json!({"modalities": ["text", "audio"]});
    if !prompt_hint.trim().is_empty() {
        response["instructions"] = json!(prompt_hint);
    }
    json!({
        "type": "response.create",
        "response": response
    })
}

pub(super) fn connection_request(
    url: &str,
    model: &str,
    api_key: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, ProviderError> {
    let mut url =
        Url::parse(url).map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
    if !url.query_pairs().any(|(key, _)| key == "model") {
        url.query_pairs_mut().append_pair("model", model);
    }
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
    request
        .headers_mut()
        .insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));
    if let Some(api_key) = api_key {
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|error| ProviderError::InvalidConfiguration(error.to_string()))?;
        request.headers_mut().insert(AUTHORIZATION, authorization);
    }
    Ok(request)
}

#[allow(clippy::cast_possible_truncation)]
pub(super) fn duration_ms(duration_us: u64) -> u16 {
    u16::try_from((duration_us / 1_000).max(1))
        .unwrap_or(u16::MAX)
        .max(1)
}

pub(super) fn pcm_duration_us(byte_len: usize) -> u64 {
    u64::try_from(byte_len).unwrap_or_default() * 1_000_000 / (u64::from(SAMPLE_RATE) * 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_adds_model_and_realtime_header() {
        let request = connection_request("ws://127.0.0.1:9000/realtime", "local-speech", None)
            .expect("request");
        assert!(request.uri().to_string().contains("model=local-speech"));
        assert_eq!(request.headers()["OpenAI-Beta"], "realtime=v1");
    }

    #[test]
    fn pcm_duration_uses_24khz_mono_s16() {
        assert_eq!(pcm_duration_us(960), 20_000);
    }

    #[test]
    fn empty_repair_instruction_is_omitted() {
        let event = response_create_event("");
        assert!(event.pointer("/response/instructions").is_none());
        let event = response_create_event("repair");
        assert_eq!(
            event
                .pointer("/response/instructions")
                .and_then(Value::as_str),
            Some("repair")
        );
    }

    #[test]
    fn session_update_disables_provider_turn_detection() {
        let event = session_update_event("brief", "alloy");
        assert_eq!(event.pointer("/session/turn_detection"), Some(&Value::Null));
    }
}
