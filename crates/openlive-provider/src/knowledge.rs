//! Lightweight local knowledge retrieval for cascade context inject.
//!
//! Loads UTF-8 `.md` / `.txt` files from a directory, chunks them, and ranks
//! by simple keyword overlap against the user transcript. Injected during
//! conversational pauses (at commit time) as system context — not a vector
//! DB, but good enough for operators' private notes without extra services.
//!
//! Swap later for embeddings + a real vector store behind the same trait.

use std::{fs, path::Path};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum KnowledgeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct KnowledgeChunk {
    pub source: String,
    pub text: String,
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct KnowledgeStore {
    chunks: Vec<KnowledgeChunk>,
}

impl KnowledgeStore {
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// Load `.md` and `.txt` files from `dir` (non-recursive).
    ///
    /// # Errors
    /// Returns when the directory cannot be read.
    pub fn load_dir(dir: impl AsRef<Path>) -> Result<Self, KnowledgeError> {
        let dir = dir.as_ref();
        if !dir.exists() {
            return Ok(Self::empty());
        }
        let mut chunks = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "md" && ext != "txt" {
                continue;
            }
            let text = fs::read_to_string(&path)?;
            let source = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            for (index, piece) in chunk_text(&text, 600).into_iter().enumerate() {
                let tokens = tokenize(&piece);
                if tokens.is_empty() {
                    continue;
                }
                chunks.push(KnowledgeChunk {
                    source: format!("{source}#{index}"),
                    text: piece,
                    tokens,
                });
            }
        }
        Ok(Self { chunks })
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    /// Rank chunks by token overlap; return top-k formatted snippets.
    #[must_use]
    pub fn retrieve(&self, query: &str, k: usize) -> Vec<String> {
        if self.chunks.is_empty() || k == 0 {
            return Vec::new();
        }
        let q = tokenize(query);
        if q.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(f32, &KnowledgeChunk)> = self
            .chunks
            .iter()
            .map(|chunk| (overlap_score(&q, &chunk.tokens), chunk))
            .filter(|(score, _)| *score > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(k)
            .map(|(_, chunk)| format!("[{}] {}", chunk.source, chunk.text.trim()))
            .collect()
    }

    /// Build a system-prompt appendix when any hits exist.
    #[must_use]
    pub fn inject_context(&self, query: &str, k: usize) -> Option<String> {
        let hits = self.retrieve(query, k);
        if hits.is_empty() {
            return None;
        }
        let mut out = String::from(
            "Relevant operator knowledge (use only if it helps answer accurately):\n",
        );
        for (i, hit) in hits.iter().enumerate() {
            out.push_str(&format!("{}. {}\n", i + 1, hit));
        }
        Some(out)
    }
}

/// Heuristic: route to a slower / deeper model when the turn looks complex.
#[must_use]
pub fn needs_deep_cognition(transcript: &str) -> bool {
    let t = transcript.to_ascii_lowercase();
    let words = t.split_whitespace().count();
    if words >= 40 {
        return true;
    }
    const MARKERS: &[&str] = &[
        "step by step",
        "think carefully",
        "reason about",
        "analyze",
        "compare and contrast",
        "write a",
        "implement",
        "debug",
        "prove that",
        "algorithm",
        "architecture",
        "trade-off",
        "tradeoff",
        "multi-step",
        "plan for",
        "design a",
    ];
    MARKERS.iter().any(|m| t.contains(m))
        || t.contains('?') && words >= 18
        || t.chars().filter(|c| c.is_ascii_digit()).count() >= 6
}

fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for para in text.split_inclusive('\n') {
        if current.len() + para.len() > max_chars && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(para);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() && !text.trim().is_empty() {
        chunks.push(text.to_owned());
    }
    chunks
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .filter(|t| !STOP.contains(t))
        .map(str::to_owned)
        .collect()
}

fn overlap_score(query: &[String], doc: &[String]) -> f32 {
    if query.is_empty() || doc.is_empty() {
        return 0.0;
    }
    let mut hits = 0u32;
    for q in query {
        if doc.iter().any(|d| d == q) {
            hits += 1;
        }
    }
    // Jaccard-ish
    let union = (query.len() + doc.len().saturating_sub(hits as usize)) as f32;
    if union <= 0.0 {
        0.0
    } else {
        hits as f32 / union * (1.0 + (hits as f32).ln_1p() * 0.15)
    }
}

const STOP: &[&str] = &[
    "the", "and", "for", "that", "with", "this", "from", "your", "have", "are",
    "was", "were", "been", "will", "would", "could", "should", "about", "into",
    "what", "when", "where", "which", "while", "than", "then", "them", "they",
    "you", "but", "not", "all", "can", "our", "out", "how", "who", "why",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn deep_cognition_detects_markers() {
        assert!(needs_deep_cognition(
            "Please think carefully and design a multi-step architecture plan."
        ));
        assert!(!needs_deep_cognition("Hey, how's the weather?"));
    }

    #[test]
    fn retrieve_ranks_matching_chunk() {
        let dir = std::env::temp_dir().join(format!(
            "openlive-know-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut file = fs::File::create(dir.join("notes.md")).unwrap();
        writeln!(file, "OpenLive prefers Piper for open neural TTS voices.").unwrap();
        writeln!(file, " unrelated gardening tips about tomatoes.").unwrap();
        let store = KnowledgeStore::load_dir(&dir).unwrap();
        let hits = store.retrieve("which tts voice should openlive use piper", 2);
        assert!(!hits.is_empty());
        assert!(hits[0].to_ascii_lowercase().contains("piper"));
        let inject = store.inject_context("piper neural tts", 1).unwrap();
        assert!(inject.contains("Relevant operator knowledge"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_store_returns_nothing() {
        let store = KnowledgeStore::empty();
        assert!(store.retrieve("anything", 3).is_empty());
        assert!(store.inject_context("x", 3).is_none());
    }
}
