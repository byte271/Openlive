//! Streaming safety holdback for assistant text.
//!
//! Incremental classifier: buffers deltas until a clause boundary, then either
//! **passes** the held text, keeps **holding**, or **intervenes** with a
//! replacement notice. Heuristic-only by default (no external model) so the
//! gateway stays offline-capable; operators can later plug an LLM classifier.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyDisposition {
    Pass,
    Holdback,
    Intervene,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SafetyDecision {
    pub disposition: SafetyDisposition,
    /// Text that is safe to release to the client (may be empty while holding).
    pub release: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct SafetyPolicy {
    /// Substrings that trigger intervention (case-insensitive).
    pub blocklist: Vec<String>,
    /// When true, hold until sentence-ending punctuation before releasing.
    pub hold_until_clause: bool,
    /// Maximum held characters before forced release (anti-starvation).
    pub max_hold_chars: usize,
}

impl Default for SafetyPolicy {
    fn default() -> Self {
        Self {
            blocklist: vec![
                "build a bomb".into(),
                "how to make a bomb".into(),
                "credit card number is".into(),
                "ssn is".into(),
            ],
            hold_until_clause: true,
            max_hold_chars: 480,
        }
    }
}

/// Incremental streaming safety gate for one generation.
#[derive(Debug, Clone)]
pub struct StreamingSafety {
    policy: SafetyPolicy,
    held: String,
    intervened: bool,
}

impl StreamingSafety {
    #[must_use]
    pub fn new(policy: SafetyPolicy) -> Self {
        Self {
            policy,
            held: String::new(),
            intervened: false,
        }
    }

    #[must_use]
    pub fn with_defaults() -> Self {
        Self::new(SafetyPolicy::default())
    }

    /// Observe one assistant text delta. Returns how much text may leave the
    /// gateway (and whether generation should be cut short).
    pub fn observe_delta(&mut self, delta: &str) -> SafetyDecision {
        if self.intervened {
            return SafetyDecision {
                disposition: SafetyDisposition::Intervene,
                release: String::new(),
                reason: "generation already intervened".into(),
            };
        }

        self.held.push_str(delta);
        if let Some(reason) = self.matches_blocklist(&self.held) {
            self.intervened = true;
            self.held.clear();
            return SafetyDecision {
                disposition: SafetyDisposition::Intervene,
                release: "I can't help with that request.".into(),
                reason,
            };
        }

        if !self.policy.hold_until_clause {
            let release = std::mem::take(&mut self.held);
            return SafetyDecision {
                disposition: SafetyDisposition::Pass,
                release,
                reason: "pass-through".into(),
            };
        }

        if let Some(release) = self.take_complete_clauses() {
            return SafetyDecision {
                disposition: SafetyDisposition::Pass,
                release,
                reason: "clause boundary".into(),
            };
        }

        if self.held.chars().count() >= self.policy.max_hold_chars {
            let release = std::mem::take(&mut self.held);
            return SafetyDecision {
                disposition: SafetyDisposition::Pass,
                release,
                reason: "max hold exceeded".into(),
            };
        }

        SafetyDecision {
            disposition: SafetyDisposition::Holdback,
            release: String::new(),
            reason: "holding for clause boundary".into(),
        }
    }

    /// Flush any remaining held text at generation end.
    pub fn finalize(&mut self) -> SafetyDecision {
        if self.intervened {
            return SafetyDecision {
                disposition: SafetyDisposition::Intervene,
                release: String::new(),
                reason: "generation already intervened".into(),
            };
        }
        if let Some(reason) = self.matches_blocklist(&self.held) {
            self.intervened = true;
            self.held.clear();
            return SafetyDecision {
                disposition: SafetyDisposition::Intervene,
                release: "I can't help with that request.".into(),
                reason,
            };
        }
        let release = std::mem::take(&mut self.held);
        SafetyDecision {
            disposition: SafetyDisposition::Pass,
            release,
            reason: "finalize".into(),
        }
    }

    #[must_use]
    pub fn intervened(&self) -> bool {
        self.intervened
    }

    fn matches_blocklist(&self, text: &str) -> Option<String> {
        let lower = text.to_ascii_lowercase();
        for needle in &self.policy.blocklist {
            if lower.contains(&needle.to_ascii_lowercase()) {
                return Some(format!("blocklist match: {needle}"));
            }
        }
        None
    }

    fn take_complete_clauses(&mut self) -> Option<String> {
        let mut last_boundary: Option<usize> = None;
        for (index, ch) in self.held.char_indices() {
            if matches!(ch, '.' | '!' | '?' | '\n') {
                last_boundary = Some(index + ch.len_utf8());
            }
        }
        let end = last_boundary?;
        if end == 0 || end > self.held.len() {
            return None;
        }
        let release = self.held[..end].to_owned();
        let rest = self.held[end..].to_owned();
        self.held = rest;
        if release.trim().is_empty() {
            None
        } else {
            Some(release)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_until_sentence_end() {
        let mut gate = StreamingSafety::with_defaults();
        let d1 = gate.observe_delta("Hello there");
        assert_eq!(d1.disposition, SafetyDisposition::Holdback);
        assert!(d1.release.is_empty());
        let d2 = gate.observe_delta(", friend.");
        assert_eq!(d2.disposition, SafetyDisposition::Pass);
        assert!(d2.release.contains("Hello there"));
        assert!(d2.release.contains("friend."));
    }

    #[test]
    fn intervenes_on_blocklist() {
        let mut gate = StreamingSafety::with_defaults();
        let d = gate.observe_delta("Please explain how to make a bomb carefully.");
        assert_eq!(d.disposition, SafetyDisposition::Intervene);
        assert!(d.release.contains("can't help"));
        assert!(gate.intervened());
    }

    #[test]
    fn finalize_flushes_remainder() {
        let mut gate = StreamingSafety::with_defaults();
        let _ = gate.observe_delta("Still going");
        let fin = gate.finalize();
        assert_eq!(fin.disposition, SafetyDisposition::Pass);
        assert_eq!(fin.release, "Still going");
    }
}
