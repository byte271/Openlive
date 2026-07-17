//! User-confirmable pending agent actions (destructive sandbox ops).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    WriteFile,
    DeleteFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAction {
    pub id: String,
    pub kind: PendingKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub created_at_ms: u64,
}

struct Entry {
    action: PendingAction,
    created: Instant,
}

fn store() -> &'static Mutex<HashMap<String, Entry>> {
    static STORE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn purge(map: &mut HashMap<String, Entry>) {
    map.retain(|_, e| e.created.elapsed() < TTL);
    // Drop oldest if over cap.
    while map.len() > MAX_PENDING {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, e)| e.created)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        } else {
            break;
        }
    }
}

/// Queue a write that would overwrite an existing file (or any write if `force_confirm`).
#[must_use]
pub fn queue_write_file(path: &str, content: &str, reason: &str) -> PendingAction {
    let preview: String = content.chars().take(200).collect();
    let action = PendingAction {
        id: Uuid::new_v4().to_string(),
        kind: PendingKind::WriteFile,
        path: path.to_owned(),
        content: Some(content.to_owned()),
        message: reason.to_owned(),
        preview: Some(preview),
        created_at_ms: now_ms(),
    };
    if let Ok(mut g) = store().lock() {
        purge(&mut g);
        g.insert(
            action.id.clone(),
            Entry {
                action: action.clone(),
                created: Instant::now(),
            },
        );
    }
    action
}

#[must_use]
pub fn queue_delete_file(path: &str) -> PendingAction {
    let action = PendingAction {
        id: Uuid::new_v4().to_string(),
        kind: PendingKind::DeleteFile,
        path: path.to_owned(),
        content: None,
        message: format!("Delete sandbox file “{path}”?"),
        preview: None,
        created_at_ms: now_ms(),
    };
    if let Ok(mut g) = store().lock() {
        purge(&mut g);
        g.insert(
            action.id.clone(),
            Entry {
                action: action.clone(),
                created: Instant::now(),
            },
        );
    }
    action
}

pub fn take(id: &str) -> Option<PendingAction> {
    let mut g = store().lock().ok()?;
    purge(&mut g);
    g.remove(id).map(|e| e.action)
}

#[must_use]
pub fn peek(id: &str) -> Option<PendingAction> {
    let mut g = store().lock().ok()?;
    purge(&mut g);
    g.get(id).map(|e| e.action.clone())
}

#[must_use]
pub fn list_pending() -> Vec<PendingAction> {
    let Ok(mut g) = store().lock() else {
        return vec![];
    };
    purge(&mut g);
    let mut v: Vec<_> = g.values().map(|e| e.action.clone()).collect();
    v.sort_by_key(|a| a.created_at_ms);
    v
}

/// Execute an approved pending action.
pub fn execute_approved(id: &str) -> Result<String, String> {
    let action = take(id).ok_or_else(|| "pending action not found or expired".to_string())?;
    match action.kind {
        PendingKind::WriteFile => {
            let content = action.content.unwrap_or_default();
            crate::sandbox::write_file(&action.path, &content)
        }
        PendingKind::DeleteFile => crate::sandbox::delete_file(&action.path),
    }
}

/// Reject (drop) a pending action.
pub fn reject(id: &str) -> Result<(), String> {
    take(id)
        .map(|_| ())
        .ok_or_else(|| "pending action not found or expired".into())
}
