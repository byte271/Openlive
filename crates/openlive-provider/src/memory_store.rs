//! Simple durable memory for OpenLive (JSON file under app data dir).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryEntry {
    pub id: String,
    pub role: String,
    pub text: String,
    pub ts_ms: u64,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryDoc {
    pub version: u32,
    pub entries: Vec<MemoryEntry>,
}

fn memory_path() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local)
            .join("openlive")
            .join("memory")
            .join("session.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".openlive")
            .join("memory")
            .join("session.json");
    }
    std::env::temp_dir()
        .join("openlive")
        .join("memory")
        .join("session.json")
}

pub fn load_memory() -> MemoryDoc {
    let path = memory_path();
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(doc) = serde_json::from_slice::<MemoryDoc>(&bytes) {
            return doc;
        }
    }
    MemoryDoc {
        version: 1,
        entries: vec![],
    }
}

pub fn save_memory(doc: &MemoryDoc) -> Result<(), String> {
    let path = memory_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

pub fn append_memory(role: &str, text: &str, tags: Vec<String>) -> Result<MemoryDoc, String> {
    let mut doc = load_memory();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    doc.entries.push(MemoryEntry {
        id: format!("m{ts}"),
        role: role.to_owned(),
        text: text.to_owned(),
        ts_ms: ts,
        tags,
    });
    // Cap size.
    if doc.entries.len() > 500 {
        let drop_n = doc.entries.len() - 500;
        doc.entries.drain(0..drop_n);
    }
    save_memory(&doc)?;
    Ok(doc)
}

pub fn export_memory_json() -> Result<Value, String> {
    let doc = load_memory();
    Ok(serde_json::to_value(doc).map_err(|e| e.to_string())?)
}

pub fn memory_file_path() -> String {
    memory_path().display().to_string()
}

pub fn clear_memory() -> Result<(), String> {
    save_memory(&MemoryDoc {
        version: 1,
        entries: vec![],
    })
}
