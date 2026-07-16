//! Short-term multi-turn session context for the agent (in-memory).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_TURNS_PER_SESSION: usize = 24;
const MAX_SESSIONS: usize = 64;
const TTL: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone)]
struct Turn {
    role: String,
    text: String,
}

struct Session {
    turns: Vec<Turn>,
    last_touch: Instant,
}

fn store() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn purge(map: &mut HashMap<String, Session>) {
    map.retain(|_, s| s.last_touch.elapsed() < TTL);
    while map.len() > MAX_SESSIONS {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, s)| s.last_touch)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        } else {
            break;
        }
    }
}

/// Append a turn and return a compact context string for the LLM.
pub fn append_and_context(session_id: &str, role: &str, text: &str, take: usize) -> String {
    let sid = session_id.trim();
    if sid.is_empty() {
        return String::new();
    }
    let text = text.trim();
    if text.is_empty() {
        return context_only(sid, take);
    }
    if let Ok(mut g) = store().lock() {
        purge(&mut g);
        let entry = g.entry(sid.to_owned()).or_insert_with(|| Session {
            turns: Vec::new(),
            last_touch: Instant::now(),
        });
        entry.last_touch = Instant::now();
        entry.turns.push(Turn {
            role: role.to_owned(),
            text: text.chars().take(500).collect(),
        });
        if entry.turns.len() > MAX_TURNS_PER_SESSION {
            let n = entry.turns.len() - MAX_TURNS_PER_SESSION;
            entry.turns.drain(0..n);
        }
    }
    context_only(sid, take)
}

pub fn context_only(session_id: &str, take: usize) -> String {
    let sid = session_id.trim();
    if sid.is_empty() {
        return String::new();
    }
    let Ok(mut g) = store().lock() else {
        return String::new();
    };
    purge(&mut g);
    let Some(s) = g.get_mut(sid) else {
        return String::new();
    };
    s.last_touch = Instant::now();
    let take = take.clamp(1, MAX_TURNS_PER_SESSION);
    s.turns
        .iter()
        .rev()
        .take(take)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|t| format!("{}: {}", t.role, t.text))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn clear_session(session_id: &str) {
    if let Ok(mut g) = store().lock() {
        g.remove(session_id.trim());
    }
}

pub fn session_stats() -> serde_json::Value {
    let Ok(mut g) = store().lock() else {
        return serde_json::json!({ "sessions": 0 });
    };
    purge(&mut g);
    serde_json::json!({
        "sessions": g.len(),
        "max_sessions": MAX_SESSIONS,
        "max_turns": MAX_TURNS_PER_SESSION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolls_context() {
        let id = "test-sess-1";
        clear_session(id);
        append_and_context(id, "user", "hello", 6);
        let ctx = append_and_context(id, "assistant", "hi there", 6);
        assert!(ctx.contains("hello"));
        assert!(ctx.contains("hi there"));
        clear_session(id);
    }
}
