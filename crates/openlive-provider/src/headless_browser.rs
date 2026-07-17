//! Optional system headless browser via Chrome/Edge CLI (`--dump-dom`).
//! No bundled Chromium — uses whatever is installed on the machine.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::tools::{
    extract_html_title, html_to_plain_public, is_blocked_browse_host_public, Citation,
};

#[derive(Debug, Clone, Serialize)]
pub struct HeadlessBrowserStatus {
    pub available: bool,
    pub browser: String,
    pub binary: String,
    pub engine: String,
    pub note: String,
}

fn has_extension(path: &str, ext: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn candidate_bins() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("OPENLIVE_BROWSER") {
        if !p.trim().is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let program = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let program_x86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
    for root in [program.as_str(), program_x86.as_str(), local.as_str()] {
        if root.is_empty() {
            continue;
        }
        out.push(PathBuf::from(root).join(r"Google\Chrome\Application\chrome.exe"));
        out.push(PathBuf::from(root).join(r"Microsoft\Edge\Application\msedge.exe"));
        out.push(PathBuf::from(root).join(r"Chromium\Application\chrome.exe"));
    }
    for name in [
        "chrome",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "msedge",
    ] {
        if let Ok(p) = which_bin(name) {
            out.push(p);
        }
    }
    out
}

fn which_bin(name: &str) -> Result<PathBuf, ()> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(name);
            if p.is_file() {
                return Ok(p);
            }
            let p_exe = dir.join(format!("{name}.exe"));
            if p_exe.is_file() {
                return Ok(p_exe);
            }
        }
    }
    Err(())
}

#[must_use]
pub fn find_browser_binary() -> Option<PathBuf> {
    candidate_bins().into_iter().find(|p| p.is_file())
}

#[must_use]
pub fn headless_browser_status() -> HeadlessBrowserStatus {
    match find_browser_binary() {
        Some(bin) => {
            let name = bin
                .file_name().map_or_else(|| "browser".into(), |s| s.to_string_lossy().into_owned());
            HeadlessBrowserStatus {
                available: true,
                browser: name,
                binary: bin.display().to_string(),
                engine: "system-headless".into(),
                note: "Chrome/Edge headless dump-dom is available for JS-rendered pages.".into(),
            }
        }
        None => HeadlessBrowserStatus {
            available: false,
            browser: "none".into(),
            binary: String::new(),
            engine: "http".into(),
            note: "No Chrome/Edge found. browse_url uses HTTP fetch only. Set OPENLIVE_BROWSER to a chromium binary.".into(),
        },
    }
}

/// Validate public http(s) URL and host (SSRF guard).
pub fn validate_public_url(url: &str) -> Result<reqwest::Url, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("url is required".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("only http/https URLs are allowed".into());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err("url missing host".into());
    }
    if is_blocked_browse_host_public(&host) {
        return Err("host is blocked (private/local networks not allowed)".into());
    }
    Ok(parsed)
}

fn dump_dom_once(
    bin: &Path,
    parsed: &reqwest::Url,
    host: &str,
) -> Result<(String, Citation, String), String> {
    let mut child = Command::new(bin)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--disable-background-networking")
        .arg("--dump-dom")
        .arg(parsed.as_str())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start browser {}: {e}", bin.display()))?;

    let start = Instant::now();
    let timeout = Duration::from_secs(18);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("headless browser timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        let mut buf = Vec::new();
        out.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        const MAX: usize = 768 * 1024;
        let slice = if buf.len() > MAX {
            &buf[..MAX]
        } else {
            &buf[..]
        };
        stdout = String::from_utf8_lossy(slice).into_owned();
    }
    let _ = child.wait();

    if stdout.len() < 40 {
        return Err("headless dump-dom returned little/no HTML".into());
    }

    let text = html_to_plain_public(&stdout);
    if text.len() < 20 {
        return Err("headless page had no readable text".into());
    }
    let title = extract_html_title(&stdout).unwrap_or_else(|| host.to_owned());
    let snippet: String = text.chars().take(220).collect();
    let body: String = text.chars().take(2200).collect();
    Ok((
        format!("{title}\n\n{body}"),
        Citation {
            title,
            url: parsed.to_string(),
            snippet,
        },
        stdout,
    ))
}

/// Fetch rendered DOM via system Chrome/Edge headless.
pub fn headless_browse(url: &str) -> Result<(String, Citation, String), String> {
    let parsed = validate_public_url(url)?;
    let host = parsed.host_str().unwrap_or("page").to_ascii_lowercase();
    let bin = find_browser_binary().ok_or_else(|| {
        "no system Chrome/Edge found (set OPENLIVE_BROWSER or install a Chromium browser)"
            .to_string()
    })?;
    dump_dom_once(&bin, &parsed, &host)
}

#[derive(Debug, Clone, Serialize)]
pub struct HeadlessScreenshotResult {
    pub path: String,
    pub relative_path: String,
    pub url: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub browser: String,
}

fn safe_shot_name(url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(std::borrow::ToOwned::to_owned))
        .unwrap_or_else(|| "page".into());
    let host: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{host}-{ts}.png")
}

/// Capture a full-page-ish screenshot via Chrome/Edge headless into the sandbox lab folder.
pub fn headless_screenshot(
    url: &str,
    width: u32,
    height: u32,
) -> Result<HeadlessScreenshotResult, String> {
    let parsed = validate_public_url(url)?;
    let bin = find_browser_binary().ok_or_else(|| {
        "no system Chrome/Edge found (set OPENLIVE_BROWSER or install a Chromium browser)"
            .to_string()
    })?;

    let width = width.clamp(320, 2560);
    let height = height.clamp(240, 4096);
    let name = safe_shot_name(parsed.as_str());
    let rel = format!("lab/screenshots/{name}");
    // Ensure sandbox + parent dirs via write path resolution.
    let out_path = crate::sandbox::resolve_in_workspace(&rel)?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Prefer writing to a temp file first then move into sandbox (chrome may need plain path).
    let tmp = std::env::temp_dir().join(format!("openlive-shot-{name}"));
    let tmp_s = tmp.display().to_string();
    let win = format!("{width},{height}");

    let mut child = Command::new(&bin)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--hide-scrollbars")
        .arg(format!("--window-size={win}"))
        .arg(format!("--screenshot={tmp_s}"))
        .arg(parsed.as_str())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start browser {}: {e}", bin.display()))?;

    let start = Instant::now();
    let timeout = Duration::from_secs(20);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&tmp);
            return Err("headless screenshot timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.wait();

    if !tmp.is_file() {
        return Err("browser did not produce a screenshot file".into());
    }
    let meta = std::fs::metadata(&tmp).map_err(|e| e.to_string())?;
    if meta.len() < 64 {
        let _ = std::fs::remove_file(&tmp);
        return Err("screenshot file too small / empty".into());
    }
    std::fs::copy(&tmp, &out_path).map_err(|e| format!("copy into sandbox: {e}"))?;
    let _ = std::fs::remove_file(&tmp);

    let browser = bin
        .file_name()
        .map_or_else(|| "browser".into(), |s| s.to_string_lossy().into_owned());

    Ok(HeadlessScreenshotResult {
        path: out_path.display().to_string(),
        relative_path: rel,
        url: parsed.to_string(),
        bytes: meta.len(),
        width,
        height,
        browser,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct HeadlessPdfResult {
    pub path: String,
    pub relative_path: String,
    pub url: String,
    pub bytes: u64,
    pub browser: String,
}

fn safe_pdf_name(url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(std::borrow::ToOwned::to_owned))
        .unwrap_or_else(|| "page".into());
    let host: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{host}-{ts}.pdf")
}

/// Print a public URL to PDF via Chrome/Edge headless into sandbox lab/pdfs/.
pub fn headless_pdf(url: &str) -> Result<HeadlessPdfResult, String> {
    let parsed = validate_public_url(url)?;
    let bin = find_browser_binary().ok_or_else(|| {
        "no system Chrome/Edge found (set OPENLIVE_BROWSER or install a Chromium browser)"
            .to_string()
    })?;

    let name = safe_pdf_name(parsed.as_str());
    let rel = format!("lab/pdfs/{name}");
    let out_path = crate::sandbox::resolve_in_workspace(&rel)?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = std::env::temp_dir().join(format!("openlive-pdf-{name}"));
    let tmp_s = tmp.display().to_string();

    let mut child = Command::new(&bin)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg(format!("--print-to-pdf={tmp_s}"))
        .arg("--no-pdf-header-footer")
        .arg(parsed.as_str())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start browser {}: {e}", bin.display()))?;

    let start = Instant::now();
    let timeout = Duration::from_secs(25);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&tmp);
            return Err("headless pdf timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.wait();

    if !tmp.is_file() {
        return Err("browser did not produce a pdf file".into());
    }
    let meta = std::fs::metadata(&tmp).map_err(|e| e.to_string())?;
    if meta.len() < 128 {
        let _ = std::fs::remove_file(&tmp);
        return Err("pdf file too small / empty".into());
    }
    // Basic PDF magic check
    let mut hdr = [0u8; 5];
    if let Ok(mut f) = std::fs::File::open(&tmp) {
        use std::io::Read;
        let _ = f.read_exact(&mut hdr);
        if &hdr != b"%PDF-" {
            let _ = std::fs::remove_file(&tmp);
            return Err("output is not a PDF".into());
        }
    }
    std::fs::copy(&tmp, &out_path).map_err(|e| format!("copy into sandbox: {e}"))?;
    let _ = std::fs::remove_file(&tmp);

    let browser = bin
        .file_name()
        .map_or_else(|| "browser".into(), |s| s.to_string_lossy().into_owned());

    Ok(HeadlessPdfResult {
        path: out_path.display().to_string(),
        relative_path: rel,
        url: parsed.to_string(),
        bytes: meta.len(),
        browser,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct LabMediaItem {
    pub kind: String, // screenshot | pdf
    pub name: String,
    pub relative_path: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// List recent screenshots and PDFs under sandbox lab.
#[must_use]
pub fn list_lab_media(limit: usize) -> Vec<LabMediaItem> {
    let limit = limit.clamp(1, 100);
    let mut items = Vec::new();
    for (kind, sub) in [("screenshot", "lab/screenshots"), ("pdf", "lab/pdfs")] {
        let Ok(dir) = crate::sandbox::resolve_in_workspace(sub) else {
            continue;
        };
        if !dir.is_dir() {
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let path = e.path();
                if !path.is_file() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                let ext_ok = match kind {
                    "screenshot" => has_extension(&name, "png"),
                    "pdf" => has_extension(&name, "pdf"),
                    _ => false,
                };
                if !ext_ok {
                    continue;
                }
                let meta = e.metadata().ok();
                let bytes = meta.as_ref().map_or(0, std::fs::Metadata::len);
                let modified_ms = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
                items.push(LabMediaItem {
                    kind: kind.into(),
                    name,
                    relative_path: format!("{sub}/{}", e.file_name().to_string_lossy()),
                    bytes,
                    modified_ms,
                });
            }
        }
    }
    items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    items.truncate(limit);
    items
}

/// Read a lab media file as base64 (path must be under lab/screenshots or lab/pdfs).
pub fn read_lab_media_base64(rel: &str) -> Result<(String, String, u64), String> {
    let rel = rel
        .trim()
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/");
    if rel.contains("..") {
        return Err("path must not contain ..".into());
    }
    let allowed = rel.starts_with("lab/screenshots/") || rel.starts_with("lab/pdfs/");
    if !allowed {
        return Err("only lab/screenshots/* and lab/pdfs/* are readable".into());
    }
    let path = crate::sandbox::resolve_in_workspace(&rel)?;
    if !path.is_file() {
        return Err("file not found".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("file too large to inline (max 4MB)".into());
    }
    let mime = if has_extension(&rel, "png") {
        "image/png"
    } else if has_extension(&rel, "pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok((STANDARD.encode(&bytes), mime.into(), bytes.len() as u64))
}
