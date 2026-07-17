//! Durable user profile (name, language, voice prefs, notes) under app data.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserProfile {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_language: Option<String>,
    /// IANA timezone id, e.g. `America/Los_Angeles`, or local offset label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// `OpenLive` TTS engine preference: auto | piper | formant | browser
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_engine: Option<String>,
    /// Formant / Piper voice id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_id: Option<String>,
    /// voice | balanced | deep
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_depth: Option<String>,
    /// general | researcher | coder | safe
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub facts: Vec<String>,
    pub updated_at_ms: u64,
}

fn profile_path() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENLIVE_TEST_PROFILE_DIR") {
        return PathBuf::from(dir).join("profile.json");
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local)
            .join("openlive")
            .join("memory")
            .join("profile.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".openlive")
            .join("memory")
            .join("profile.json");
    }
    std::env::temp_dir()
        .join("openlive")
        .join("memory")
        .join("profile.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[must_use]
pub fn profile_file_path() -> String {
    profile_path().display().to_string()
}

#[must_use]
pub fn load_profile() -> UserProfile {
    let path = profile_path();
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(mut doc) = serde_json::from_slice::<UserProfile>(&bytes) {
            if doc.version < 1 {
                doc.version = 1;
            }
            // Bump schema version when new fields are present.
            if doc.version < 2 {
                doc.version = 2;
            }
            return doc;
        }
    }
    UserProfile {
        version: 2,
        updated_at_ms: now_ms(),
        ..Default::default()
    }
}

pub fn save_profile(doc: &UserProfile) -> Result<(), String> {
    let path = profile_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

pub fn set_display_name(name: &str) -> Result<UserProfile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name is empty".into());
    }
    if name.chars().count() > 60 {
        return Err("name too long".into());
    }
    let mut p = load_profile();
    p.display_name = Some(name.to_owned());
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

pub fn set_preferred_language(lang: &str) -> Result<UserProfile, String> {
    let lang = lang.trim();
    let mut p = load_profile();
    p.preferred_language = if lang.is_empty() {
        None
    } else {
        Some(lang.to_owned())
    };
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

/// Merge arbitrary allowed fields from a JSON object.
pub fn patch_profile(partial: &Value) -> Result<UserProfile, String> {
    let mut p = load_profile();
    let mut changed = false;

    if let Some(name) = partial
        .get("display_name")
        .or_else(|| partial.get("name"))
        .and_then(Value::as_str)
    {
        let name = name.trim();
        if !name.is_empty() && name.chars().count() <= 60 {
            p.display_name = Some(name.to_owned());
            changed = true;
        }
    }
    if let Some(lang) = partial.get("preferred_language").and_then(Value::as_str) {
        let lang = lang.trim();
        p.preferred_language = if lang.is_empty() {
            None
        } else {
            Some(lang.to_owned())
        };
        changed = true;
    }
    if let Some(tz) = partial.get("timezone").and_then(Value::as_str) {
        let tz = tz.trim();
        p.timezone = if tz.is_empty() {
            None
        } else {
            Some(tz.chars().take(80).collect())
        };
        changed = true;
    }
    if let Some(eng) = partial.get("tts_engine").and_then(Value::as_str) {
        let eng = eng.trim().to_ascii_lowercase();
        if matches!(eng.as_str(), "auto" | "piper" | "formant" | "browser") {
            p.tts_engine = Some(eng);
            changed = true;
        }
    }
    if let Some(vid) = partial.get("voice_id").and_then(Value::as_str) {
        let vid = vid.trim();
        p.voice_id = if vid.is_empty() {
            None
        } else {
            Some(vid.chars().take(80).collect())
        };
        changed = true;
    }
    if let Some(d) = partial.get("thought_depth").and_then(Value::as_str) {
        let d = d.trim().to_ascii_lowercase();
        if matches!(d.as_str(), "voice" | "balanced" | "deep") {
            p.thought_depth = Some(d);
            changed = true;
        }
    }
    if let Some(c) = partial.get("agent_class").and_then(Value::as_str) {
        let c = c.trim().to_ascii_lowercase();
        if matches!(c.as_str(), "general" | "researcher" | "coder" | "safe") {
            p.agent_class = Some(c);
            changed = true;
        }
    }
    if let Some(notes) = partial.get("notes").and_then(Value::as_str) {
        let notes = notes.trim();
        p.notes = if notes.is_empty() {
            None
        } else {
            Some(notes.chars().take(500).collect())
        };
        changed = true;
    }
    if let Some(fact) = partial.get("fact").and_then(Value::as_str) {
        let fact = fact.trim();
        if !fact.is_empty() {
            let f = fact.chars().take(200).collect::<String>();
            if !p.facts.iter().any(|x| x.eq_ignore_ascii_case(&f)) {
                p.facts.push(f);
            }
            if p.facts.len() > 40 {
                let n = p.facts.len() - 40;
                p.facts.drain(0..n);
            }
            changed = true;
        }
    }

    if !changed {
        return Err("no recognized profile fields to update".into());
    }
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

pub fn add_fact(fact: &str) -> Result<UserProfile, String> {
    patch_profile(&serde_json::json!({ "fact": fact }))
}

/// Remove a fact by 0-based index.
pub fn remove_fact_at(index: usize) -> Result<UserProfile, String> {
    let mut p = load_profile();
    if index >= p.facts.len() {
        return Err(format!(
            "fact index {index} out of range (have {})",
            p.facts.len()
        ));
    }
    let removed = p.facts.remove(index);
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    let _ = removed;
    Ok(p)
}

/// Remove first fact that matches exactly (case-insensitive).
pub fn remove_fact_text(fact: &str) -> Result<UserProfile, String> {
    let fact = fact.trim();
    if fact.is_empty() {
        return Err("fact is empty".into());
    }
    let mut p = load_profile();
    let before = p.facts.len();
    p.facts
        .retain(|f| !f.eq_ignore_ascii_case(fact) && f.trim() != fact);
    if p.facts.len() == before {
        return Err("fact not found".into());
    }
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

pub fn clear_facts() -> Result<UserProfile, String> {
    let mut p = load_profile();
    p.facts.clear();
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

/// Replace fact text at index.
pub fn update_fact_at(index: usize, fact: &str) -> Result<UserProfile, String> {
    let fact = fact.trim();
    if fact.is_empty() {
        return Err("fact is empty".into());
    }
    if fact.chars().count() > 200 {
        return Err("fact too long".into());
    }
    let mut p = load_profile();
    if index >= p.facts.len() {
        return Err(format!(
            "fact index {index} out of range (have {})",
            p.facts.len()
        ));
    }
    p.facts[index] = fact.chars().take(200).collect();
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

/// Move fact at `from` to `to` (0-based indices).
pub fn move_fact(from: usize, to: usize) -> Result<UserProfile, String> {
    let mut p = load_profile();
    let n = p.facts.len();
    if n == 0 {
        return Err("no facts".into());
    }
    if from >= n || to >= n {
        return Err(format!("index out of range (have {n})"));
    }
    if from != to {
        let item = p.facts.remove(from);
        p.facts.insert(to, item);
    }
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

/// Reorder facts by a full permutation of indices (for drag-and-drop).
/// Example: `[2, 0, 1]` means former index 2 becomes first.
pub fn reorder_facts(order: &[usize]) -> Result<UserProfile, String> {
    let mut p = load_profile();
    let n = p.facts.len();
    if n == 0 {
        return Err("no facts".into());
    }
    if order.len() != n {
        return Err(format!(
            "order length {} must equal facts {}",
            order.len(),
            n
        ));
    }
    let mut seen = vec![false; n];
    let mut next = Vec::with_capacity(n);
    for &i in order {
        if i >= n {
            return Err(format!("index {i} out of range (have {n})"));
        }
        if seen[i] {
            return Err(format!("duplicate index {i} in order"));
        }
        seen[i] = true;
        next.push(p.facts[i].clone());
    }
    p.facts = next;
    p.updated_at_ms = now_ms();
    p.version = p.version.max(2);
    save_profile(&p)?;
    Ok(p)
}

pub fn clear_profile() -> Result<(), String> {
    save_profile(&UserProfile {
        version: 2,
        updated_at_ms: now_ms(),
        ..Default::default()
    })
}

pub fn export_profile_json() -> Result<Value, String> {
    let p = load_profile();
    serde_json::to_value(p).map_err(|e| e.to_string())
}

/// Compact line for LLM / offline continuity.
#[must_use]
pub fn profile_context_line() -> String {
    let p = load_profile();
    let mut parts = Vec::new();
    if let Some(n) = p.display_name.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("User's name: {n}"));
    }
    if let Some(l) = p.preferred_language.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("Preferred language: {l}"));
    }
    if let Some(tz) = p.timezone.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("Timezone: {tz}"));
    }
    if let Some(eng) = p.tts_engine.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("TTS preference: {eng}"));
    }
    if let Some(d) = p.thought_depth.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("Thought depth preference: {d}"));
    }
    if let Some(c) = p.agent_class.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!("Agent class preference: {c}"));
    }
    for f in p.facts.iter().rev().take(5) {
        parts.push(format!("Fact: {f}"));
    }
    if let Some(n) = p.notes.as_ref().filter(|s| !s.is_empty()) {
        parts.push(format!(
            "Notes: {}",
            n.chars().take(160).collect::<String>()
        ));
    }
    parts.join("\n")
}

/// Snapshot for UI setup hydration.
#[must_use]
pub fn profile_setup_hints() -> Value {
    let p = load_profile();
    serde_json::json!({
        "display_name": p.display_name,
        "preferred_language": p.preferred_language,
        "timezone": p.timezone,
        "tts_engine": p.tts_engine,
        "voice_id": p.voice_id,
        "thought_depth": p.thought_depth,
        "agent_class": p.agent_class,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises tests that mutate the process-wide profile directory so
    /// parallel guards do not race on `OPENLIVE_TEST_PROFILE_DIR`.
    static TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Temporarily redirects profile storage to a test directory and cleans
    /// it up when dropped.
    struct ProfileTestGuard {
        original: Option<String>,
        dir: std::path::PathBuf,
    }

    impl ProfileTestGuard {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "openlive-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let original = std::env::var("OPENLIVE_TEST_PROFILE_DIR").ok();
            std::env::set_var("OPENLIVE_TEST_PROFILE_DIR", &dir);
            Self { original, dir }
        }
    }

    impl Drop for ProfileTestGuard {
        fn drop(&mut self) {
            if let Some(ref dir) = self.original {
                std::env::set_var("OPENLIVE_TEST_PROFILE_DIR", dir);
            } else {
                std::env::remove_var("OPENLIVE_TEST_PROFILE_DIR");
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn set_and_load_name() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let _guard = ProfileTestGuard::new();
        let _ = set_display_name("TestUserOpenLive");
        let p = load_profile();
        assert_eq!(p.display_name.as_deref(), Some("TestUserOpenLive"));
    }

    #[test]
    fn patch_timezone() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let _guard = ProfileTestGuard::new();
        let p = patch_profile(&serde_json::json!({ "timezone": "UTC" })).unwrap();
        assert_eq!(p.timezone.as_deref(), Some("UTC"));
    }
}
