//! `OpenLive` workspace sandbox — constrained file I/O under app data.
//! Not a full multi-agent OS; safe foundation for agent file tools.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SandboxStatus {
    pub root: String,
    pub workspace: String,
    pub exists: bool,
    pub files: Vec<String>,
}

pub fn sandbox_root() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("openlive").join("sandbox");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".openlive").join("sandbox");
    }
    std::env::temp_dir().join("openlive").join("sandbox")
}

pub fn workspace_dir() -> PathBuf {
    sandbox_root().join("workspace")
}

pub fn ensure_sandbox() -> Result<PathBuf, String> {
    let ws = workspace_dir();
    fs::create_dir_all(&ws).map_err(|e| e.to_string())?;
    fs::create_dir_all(sandbox_root().join("lab")).map_err(|e| e.to_string())?;
    fs::create_dir_all(sandbox_root().join("test")).map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Resolve a user path strictly inside workspace (no `..` escape).
pub fn resolve_in_workspace(rel: &str) -> Result<PathBuf, String> {
    let ws = ensure_sandbox()?;
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return Ok(ws);
    }
    if rel.contains("..") {
        return Err("path must not contain ..".into());
    }
    let path = ws.join(rel);
    let canon_ws = ws.canonicalize().unwrap_or(ws.clone());
    // For new files parent must stay under workspace.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let canon = path.canonicalize().map_err(|e| e.to_string())?;
        if !canon.starts_with(&canon_ws) {
            return Err("path escapes sandbox".into());
        }
        return Ok(canon);
    }
    // Best-effort check for new paths.
    let joined = ws.join(rel);
    Ok(joined)
}

#[must_use]
pub fn sandbox_status() -> SandboxStatus {
    let root = sandbox_root();
    let ws = workspace_dir();
    let _ = ensure_sandbox();
    let mut files = Vec::new();
    if let Ok(rd) = fs::read_dir(&ws) {
        for e in rd.flatten().take(100) {
            let name = e.file_name().to_string_lossy().to_string();
            let meta = e.metadata().ok();
            let kind = if meta.as_ref().is_some_and(std::fs::Metadata::is_dir) {
                "dir"
            } else {
                "file"
            };
            files.push(format!("{kind}:{name}"));
        }
    }
    SandboxStatus {
        root: root.display().to_string(),
        workspace: ws.display().to_string(),
        exists: ws.is_dir(),
        files,
    }
}

pub fn list_files(rel: &str) -> Result<Vec<String>, String> {
    let path = resolve_in_workspace(rel)?;
    if !path.is_dir() {
        return Err("not a directory".into());
    }
    let mut out = Vec::new();
    for e in fs::read_dir(&path).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let suffix = if e.path().is_dir() { "/" } else { "" };
        out.push(format!("{name}{suffix}"));
    }
    out.sort();
    Ok(out)
}

pub fn read_file(rel: &str) -> Result<String, String> {
    let path = resolve_in_workspace(rel)?;
    if !path.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_READ_BYTES {
        return Err(format!("file too large (max {MAX_READ_BYTES} bytes)"));
    }
    String::from_utf8(bytes).map_err(|_| "file is not utf-8 text".into())
}

pub fn path_exists(rel: &str) -> Result<bool, String> {
    let path = resolve_in_workspace(rel)?;
    Ok(path.exists())
}

pub fn write_file(rel: &str, content: &str) -> Result<String, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("content too large (max {MAX_WRITE_BYTES} bytes)"));
    }
    let path = resolve_in_workspace(rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        path.display()
    ))
}

pub fn delete_file(rel: &str) -> Result<String, String> {
    let path = resolve_in_workspace(rel)?;
    let ws = workspace_dir();
    let canon_ws = ws.canonicalize().unwrap_or(ws);
    if path.exists() {
        let canon = path.canonicalize().map_err(|e| e.to_string())?;
        if !canon.starts_with(&canon_ws) {
            return Err("path escapes sandbox".into());
        }
        if canon.is_dir() {
            fs::remove_dir_all(&canon).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&canon).map_err(|e| e.to_string())?;
        }
        Ok(format!("deleted {rel}"))
    } else {
        Err("path not found".into())
    }
}

/// Relative path display helper.
#[allow(dead_code)]
pub fn path_under_workspace(path: &Path) -> String {
    let ws = workspace_dir();
    path.strip_prefix(&ws)
        .map_or_else(|_| path.display().to_string(), |p| p.display().to_string())
}
