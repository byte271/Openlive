//! File-backed session persistence for task outcomes, evidence links, and
//! resume buffers. Uses append-only JSONL under a configurable directory so
//! the gateway stays dependency-light (no native SQLite linkage required).
//!
//! Schema is intentionally SQLite-shaped so a future `rusqlite` backend can
//! replace the JSONL files without changing callers.

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid store: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedEnvelope {
    pub session_id: Uuid,
    pub sequence: u64,
    pub event_id: Uuid,
    pub recorded_at_ms: u64,
    /// Full EventEnvelope JSON for byte-stable resume replay.
    pub envelope_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedTask {
    pub session_id: Uuid,
    pub task_id: Uuid,
    pub intent: String,
    pub status: String,
    pub deadline_ms: u64,
    pub generation_id: Option<Uuid>,
    pub summary: Option<String>,
    pub updated_at_ms: u64,
}

/// On-disk session store: `{root}/{session_id}/events.jsonl` + `tasks.jsonl`.
#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
}

impl SessionStore {
    /// Open or create a store directory.
    ///
    /// # Errors
    /// Returns when the directory cannot be created.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, PersistenceError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn session_dir(&self, session_id: Uuid) -> PathBuf {
        self.root.join(session_id.to_string())
    }

    fn ensure_session(&self, session_id: Uuid) -> Result<PathBuf, PersistenceError> {
        let dir = self.session_dir(session_id);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Append a pre-serialized control envelope for resume replay.
    ///
    /// # Errors
    /// Returns on IO or serialization failure.
    pub fn append_envelope(
        &self,
        session_id: Uuid,
        sequence: u64,
        event_id: Uuid,
        recorded_at_ms: u64,
        envelope_json: &str,
    ) -> Result<(), PersistenceError> {
        let dir = self.ensure_session(session_id)?;
        let path = dir.join("events.jsonl");
        let record = PersistedEnvelope {
            session_id,
            sequence,
            event_id,
            recorded_at_ms,
            envelope_json: envelope_json.to_owned(),
        };
        append_jsonl(&path, &record)
    }

    /// Load envelopes with `sequence > after_sequence`, ordered ascending.
    ///
    /// # Errors
    /// Returns on IO or parse failure.
    pub fn load_envelopes_after(
        &self,
        session_id: Uuid,
        after_sequence: u64,
    ) -> Result<Vec<PersistedEnvelope>, PersistenceError> {
        let path = self.session_dir(session_id).join("events.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut rows = read_jsonl::<PersistedEnvelope>(&path)?;
        rows.retain(|row| row.sequence > after_sequence);
        rows.sort_by_key(|row| row.sequence);
        Ok(rows)
    }

    /// Upsert a task record (status transitions).
    ///
    /// # Errors
    /// Returns on IO failure.
    pub fn upsert_task(&self, task: &PersistedTask) -> Result<(), PersistenceError> {
        let dir = self.ensure_session(task.session_id)?;
        let path = dir.join("tasks.jsonl");
        // Append-only log of task snapshots; latest wins on read.
        append_jsonl(&path, task)
    }

    /// Latest snapshot per task_id for a session.
    ///
    /// # Errors
    /// Returns on IO or parse failure.
    pub fn list_tasks(&self, session_id: Uuid) -> Result<Vec<PersistedTask>, PersistenceError> {
        let path = self.session_dir(session_id).join("tasks.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let rows = read_jsonl::<PersistedTask>(&path)?;
        let mut latest = std::collections::BTreeMap::new();
        for row in rows {
            latest.insert(row.task_id, row);
        }
        Ok(latest.into_values().collect())
    }

    /// List session ids that have on-disk state.
    ///
    /// # Errors
    /// Returns on directory read failure.
    pub fn list_session_ids(&self) -> Result<Vec<Uuid>, PersistenceError> {
        let mut ids = Vec::new();
        if !self.root.exists() {
            return Ok(ids);
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Ok(id) = Uuid::parse_str(&entry.file_name().to_string_lossy()) {
                ids.push(id);
            }
        }
        ids.sort_unstable();
        Ok(ids)
    }
}

fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), PersistenceError> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let line = serde_json::to_string(value)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, PersistenceError> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        out.push(serde_json::from_str(trimmed)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_store() -> SessionStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("openlive-persist-{stamp}"));
        SessionStore::open(path).expect("store")
    }

    #[test]
    fn envelope_round_trip_orders_by_sequence() {
        let store = tmp_store();
        let session = Uuid::new_v4();
        store
            .append_envelope(session, 2, Uuid::new_v4(), 100, r#"{"seq":2}"#)
            .unwrap();
        store
            .append_envelope(session, 1, Uuid::new_v4(), 90, r#"{"seq":1}"#)
            .unwrap();
        store
            .append_envelope(session, 3, Uuid::new_v4(), 110, r#"{"seq":3}"#)
            .unwrap();
        let after_one = store.load_envelopes_after(session, 1).unwrap();
        assert_eq!(after_one.len(), 2);
        assert_eq!(after_one[0].sequence, 2);
        assert_eq!(after_one[1].sequence, 3);
    }

    #[test]
    fn task_upsert_keeps_latest_status() {
        let store = tmp_store();
        let session = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        store
            .upsert_task(&PersistedTask {
                session_id: session,
                task_id,
                intent: "remind me".into(),
                status: "acknowledged".into(),
                deadline_ms: 1_000,
                generation_id: None,
                summary: None,
                updated_at_ms: 1,
            })
            .unwrap();
        store
            .upsert_task(&PersistedTask {
                session_id: session,
                task_id,
                intent: "remind me".into(),
                status: "completed".into(),
                deadline_ms: 1_000,
                generation_id: Some(Uuid::new_v4()),
                summary: Some("done".into()),
                updated_at_ms: 2,
            })
            .unwrap();
        let tasks = store.list_tasks(session).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(tasks[0].summary.as_deref(), Some("done"));
    }

    #[test]
    fn lists_session_ids() {
        let store = tmp_store();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        store
            .append_envelope(a, 1, Uuid::new_v4(), 1, "{}")
            .unwrap();
        store
            .append_envelope(b, 1, Uuid::new_v4(), 1, "{}")
            .unwrap();
        let ids = store.list_session_ids().unwrap();
        assert!(ids.contains(&a));
        assert!(ids.contains(&b));
    }
}
