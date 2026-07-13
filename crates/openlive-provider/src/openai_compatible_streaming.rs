use futures_util::StreamExt;
use reqwest::Response;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::openai_compatible::{checked_response, FRAME_DURATION_MS, OUTPUT_SAMPLE_RATE};

#[derive(Debug)]
pub(super) enum CompletionEvent {
    Delta(String),
    Complete,
    Error(String),
}

pub(super) async fn stream_sse(
    response: Response,
    sender: &mpsc::Sender<CompletionEvent>,
    cancellation: &CancellationToken,
) {
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    loop {
        let item = tokio::select! {
            () = cancellation.cancelled() => return,
            item = stream.next() => item,
        };
        let Some(item) = item else {
            let _ = sender.send(CompletionEvent::Complete).await;
            return;
        };
        let chunk = match item {
            Ok(chunk) => chunk,
            Err(error) => {
                let _ = sender.send(CompletionEvent::Error(error.to_string())).await;
                return;
            }
        };
        pending.extend_from_slice(&chunk);
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=newline).collect();
            match parse_sse_line(&line) {
                Ok(Some(CompletionEvent::Complete)) => {
                    let _ = sender.send(CompletionEvent::Complete).await;
                    return;
                }
                Ok(Some(event)) => {
                    if sender.send(event).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = sender.send(CompletionEvent::Error(error)).await;
                    return;
                }
            }
        }
    }
}

pub(super) async fn stream_json_completion(
    response: Response,
    sender: &mpsc::Sender<CompletionEvent>,
) {
    let payload = match checked_response(response).await {
        Ok(payload) => payload,
        Err(error) => {
            let _ = sender.send(CompletionEvent::Error(error)).await;
            return;
        }
    };
    let completion: ChatResponse = match serde_json::from_slice(&payload) {
        Ok(completion) => completion,
        Err(error) => {
            let _ = sender.send(CompletionEvent::Error(error.to_string())).await;
            return;
        }
    };
    let Some(content) = completion
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
    else {
        let _ = sender
            .send(CompletionEvent::Error(
                "completion returned no choices".to_owned(),
            ))
            .await;
        return;
    };
    let _ = sender.send(CompletionEvent::Delta(content)).await;
    let _ = sender.send(CompletionEvent::Complete).await;
}

fn parse_sse_line(line: &[u8]) -> Result<Option<CompletionEvent>, String> {
    let line = String::from_utf8_lossy(line);
    let trimmed = line.trim();
    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok(None);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(Some(CompletionEvent::Complete));
    }
    let value: Value = serde_json::from_str(data).map_err(|error| error.to_string())?;
    let delta = value
        .pointer("/choices/0/delta/content")
        .or_else(|| value.pointer("/choices/0/text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if delta.is_empty() {
        Ok(None)
    } else {
        Ok(Some(CompletionEvent::Delta(delta.to_owned())))
    }
}

#[derive(Default)]
pub(super) struct SpeechSegmenter {
    buffer: String,
}

impl SpeechSegmenter {
    pub(super) fn push(&mut self, delta: &str) -> Vec<String> {
        self.buffer.push_str(delta);
        let mut segments = Vec::new();
        while let Some(end) = self.next_boundary() {
            let segment: String = self.buffer.drain(..end).collect();
            let segment = segment.trim().to_owned();
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
        segments
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        let remaining = std::mem::take(&mut self.buffer);
        let remaining = remaining.trim();
        (!remaining.is_empty()).then(|| remaining.to_owned())
    }

    fn next_boundary(&self) -> Option<usize> {
        let mut character_count = 0_usize;
        let mut fallback = None;
        for (index, character) in self.buffer.char_indices() {
            character_count = character_count.saturating_add(1);
            let end = index + character.len_utf8();
            if character_count >= 18 && matches!(character, '.' | '!' | '?' | ';' | ':' | '\n') {
                return Some(end);
            }
            if character_count >= 40 && character.is_whitespace() {
                fallback = Some(end);
            }
            if character_count >= 72 {
                return fallback.or(Some(end));
            }
        }
        None
    }
}

#[derive(Default)]
pub(super) struct PcmFramer {
    buffer: Vec<u8>,
}

impl PcmFramer {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(chunk);
        let frame_size = pcm_frame_size();
        let mut frames = Vec::new();
        while self.buffer.len() >= frame_size {
            let remainder = self.buffer.split_off(frame_size);
            frames.push(std::mem::replace(&mut self.buffer, remainder));
        }
        frames
    }

    pub(super) fn finish(mut self) -> Option<Vec<u8>> {
        if self.buffer.is_empty() {
            return None;
        }
        self.buffer.resize(pcm_frame_size(), 0);
        Some(self.buffer)
    }
}

fn pcm_frame_size() -> usize {
    usize::try_from(OUTPUT_SAMPLE_RATE).unwrap_or_default() * 2 * usize::from(FRAME_DURATION_MS)
        / 1_000
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_segmenter_emits_early_complete_clause() {
        let mut segmenter = SpeechSegmenter::default();
        assert!(segmenter.push("This is a natural opening").is_empty());
        let segments = segmenter.push(" sentence. The next thought");
        assert_eq!(segments, vec!["This is a natural opening sentence."]);
        assert_eq!(segmenter.finish().as_deref(), Some("The next thought"));
    }

    #[test]
    fn pcm_framer_preserves_and_pads_stream_bytes() {
        let mut packetizer = PcmFramer::default();
        let output_frames = packetizer.push(&vec![1_u8; pcm_frame_size() + 100]);
        assert_eq!(output_frames.len(), 1);
        assert_eq!(output_frames[0].len(), pcm_frame_size());
        let final_frame = packetizer.finish().expect("final frame");
        assert_eq!(final_frame.len(), pcm_frame_size());
        assert!(final_frame[..100].iter().all(|byte| *byte == 1));
        assert!(final_frame[100..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn parses_streaming_delta() {
        let event = parse_sse_line(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n")
            .expect("parse");
        assert!(matches!(event, Some(CompletionEvent::Delta(delta)) if delta == "Hi"));
    }
}
