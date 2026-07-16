//! Lightweight in-memory registry of active realtime sessions for the
//! developer REST surface (`GET /v1/sessions`).

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: Uuid,
    pub opened_at_ms: u64,
    pub provider_id: String,
}

impl SessionInfo {
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "session_id": self.session_id,
            "opened_at_ms": self.opened_at_ms,
            "provider_id": self.provider_id,
        })
    }
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<Uuid, SessionInfo>>,
    opened_total: AtomicU64,
}

impl SessionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, session_id: Uuid, provider_id: impl Into<String>) {
        let info = SessionInfo {
            session_id,
            opened_at_ms: now_ms(),
            provider_id: provider_id.into(),
        };
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(session_id, info);
        }
        self.opened_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn unregister(&self, session_id: Uuid) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.remove(&session_id);
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.inner
            .lock()
            .map(|guard| guard.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn active_count(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    pub fn opened_total(&self) -> u64 {
        self.opened_total.load(Ordering::Relaxed)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_list_unregister() {
        let reg = SessionRegistry::new();
        let id = Uuid::new_v4();
        reg.register(id, "mock");
        assert_eq!(reg.active_count(), 1);
        assert_eq!(reg.list()[0].session_id, id);
        reg.unregister(id);
        assert_eq!(reg.active_count(), 0);
        assert_eq!(reg.opened_total(), 1);
    }
}
