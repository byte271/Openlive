//! Open-source Piper TTS integration (optional local binary).
//! When missing, expose a copy-paste install command with absolute paths.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Default model id we ship install instructions for.
pub const DEFAULT_PIPER_VOICE: &str = "en_US-lessac-medium";

#[derive(Debug, Clone, Serialize)]
pub struct PiperStatus {
    pub available: bool,
    pub engine: String,
    pub data_dir: String,
    pub piper_bin: String,
    pub model_path: String,
    pub model_present: bool,
    pub bin_present: bool,
    pub install_command_windows: String,
    pub install_command_unix: String,
    pub note: String,
}

/// Platform data directory: `%LOCALAPPDATA%\openlive\piper` or `~/.openlive/piper`.
#[must_use]
pub fn piper_data_dir() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("openlive").join("piper");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".openlive").join("piper");
    }
    std::env::temp_dir().join("openlive").join("piper")
}

pub fn piper_bin_path(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("piper").join("piper.exe")
    } else {
        dir.join("piper").join("piper")
    }
}

pub fn piper_model_path(dir: &Path, voice: &str) -> PathBuf {
    dir.join("models").join(format!("{voice}.onnx"))
}

#[must_use]
pub fn piper_status(voice: &str) -> PiperStatus {
    let dir = piper_data_dir();
    let bin = resolve_piper_bin(&dir);
    let model = piper_model_path(&dir, voice);
    let bin_present = bin.is_file();
    let model_present = model.is_file();
    // Ready when binary + model exist; synthesize sets cwd for DLLs.
    let dll_ok = bin.parent().is_some_and(|p| {
        p.join("onnxruntime.dll").is_file()
            || p.join("espeak-ng.dll").is_file()
            || p.join("piper_phonemize.dll").is_file()
    });
    let available = bin_present && model_present && dll_ok;

    let dir_s = dir.display().to_string();
    let bin_s = bin.display().to_string();
    let model_s = model.display().to_string();

    let win = format!(
        r#"# OpenLive · install open-source Piper TTS (Windows PowerShell)
# Prefer: powershell -ExecutionPolicy Bypass -File scripts\install-piper.ps1
$dir = "{dir_s}"
$binDir = "$dir\piper"; $models = "$dir\models"
New-Item -ItemType Directory -Force -Path $binDir,$models | Out-Null
$zip = "$dir\piper-windows.zip"
Invoke-WebRequest -Uri "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" -OutFile $zip
$ex = "$dir\_extract"; if (Test-Path $ex) {{ Remove-Item $ex -Recurse -Force }}; Expand-Archive $zip $ex -Force
$exe = Get-ChildItem $ex -Recurse -Filter piper.exe | Where-Object {{ Test-Path (Join-Path $_.DirectoryName 'onnxruntime.dll') }} | Select-Object -First 1
if (-not $exe) {{ $exe = Get-ChildItem $ex -Recurse -Filter piper.exe | Select-Object -First 1 }}
Copy-Item (Join-Path $exe.DirectoryName '*') $binDir -Recurse -Force
Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" -OutFile "{model_s}"
Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" -OutFile "{model_s}.json"
Write-Host "Installed. Binary: $binDir\piper.exe  Model: {model_s}"
Write-Host "Restart openlive-gateway (127.0.0.1:12345). Settings → TTS → Auto/Piper."
"#
    );

    let unix = format!(
        r#"# OpenLive · install open-source Piper TTS (Linux/macOS)
DIR="{dir_s}"
mkdir -p "$DIR/piper" "$DIR/models"
# Download a piper release for your OS from https://github.com/rhasspy/piper/releases
# Example (linux x64):
# curl -L -o /tmp/piper.tar.gz "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
# tar -xzf /tmp/piper.tar.gz -C "$DIR/piper" --strip-components=1
curl -L -o "{model_s}" \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
curl -L -o "{model_s}.json" \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
echo "Model: {model_s}"
echo "Place piper binary at: {bin_s}"
"#
    );

    let note = if available {
        "Piper is ready — OpenLive will use open-source neural TTS.".into()
    } else if !bin_present && !model_present {
        "Piper binary and voice model are missing. Copy-paste the install command for your OS."
            .into()
    } else if !bin_present {
        "Piper binary missing (model found). Run the install command.".into()
    } else {
        "Piper binary found but voice model missing. Run the install command.".into()
    };

    PiperStatus {
        available,
        engine: if available {
            "piper".into()
        } else {
            "missing".into()
        },
        data_dir: dir_s,
        piper_bin: bin_s,
        model_path: model_s,
        model_present,
        bin_present,
        install_command_windows: win,
        install_command_unix: unix,
        note,
    }
}

/// Resolve the Piper executable that sits next to its DLLs (onnxruntime, espeak-ng).
/// Installers sometimes nest `piper/piper/piper.exe`; we prefer the layout with DLLs.
pub fn resolve_piper_bin(data_dir: &Path) -> PathBuf {
    let candidates = [
        data_dir.join("piper").join("piper.exe"),
        data_dir.join("piper").join("piper").join("piper.exe"),
        data_dir.join("piper.exe"),
    ];
    for c in candidates {
        if !c.is_file() {
            continue;
        }
        if let Some(parent) = c.parent() {
            let has_dll = parent.join("onnxruntime.dll").is_file()
                || parent.join("espeak-ng.dll").is_file()
                || parent.join("piper_phonemize.dll").is_file();
            if has_dll {
                return c;
            }
        }
    }
    // Fall back to the documented path even if DLLs are missing (status will explain).
    piper_bin_path(data_dir)
}

/// Synthesize PCM s16le mono via piper CLI. Returns (`pcm_bytes`, `sample_rate`) or error.
pub fn piper_synthesize(text: &str, voice: &str) -> Result<(Vec<u8>, u32), String> {
    let dir = piper_data_dir();
    let bin = resolve_piper_bin(&dir);
    let model = piper_model_path(&dir, voice);
    if !bin.is_file() {
        return Err(format!("piper binary missing at {}", bin.display()));
    }
    if !model.is_file() {
        return Err(format!("piper model missing at {}", model.display()));
    }
    let out_wav = dir.join("last.wav");
    let work_dir = bin.parent().unwrap_or(Path::new("."));

    // Piper must run with cwd = binary dir so Windows finds onnxruntime / espeak-ng DLLs.
    // Text via stdin; Piper writes a WAV file.
    let mut child = Command::new(&bin)
        .current_dir(work_dir)
        .arg("--model")
        .arg(&model)
        .arg("--output_file")
        .arg(&out_wav)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start piper ({}): {e}", bin.display()))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let line = text.trim();
        let _ = stdin.write_all(line.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("piper wait: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("piper failed (cwd {}): {err}", work_dir.display()));
    }
    if !out_wav.is_file() {
        return Err("piper produced no wav".into());
    }
    let wav = std::fs::read(&out_wav).map_err(|e| e.to_string())?;
    let (pcm, rate) = wav_to_pcm_s16le(&wav)?;
    Ok((pcm, rate))
}

fn wav_to_pcm_s16le(wav: &[u8]) -> Result<(Vec<u8>, u32), String> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("not a wav file".into());
    }
    // Find "data" chunk.
    let mut i = 12usize;
    let mut sample_rate = 22050u32;
    while i + 8 <= wav.len() {
        let id = &wav[i..i + 4];
        let size = u32::from_le_bytes(wav[i + 4..i + 8].try_into().unwrap()) as usize;
        if id == b"fmt " && i + 24 <= wav.len() {
            sample_rate = u32::from_le_bytes(wav[i + 12..i + 16].try_into().unwrap());
        }
        if id == b"data" {
            let start = i + 8;
            let end = (start + size).min(wav.len());
            return Ok((wav[start..end].to_vec(), sample_rate));
        }
        i += 8 + size;
        if size % 2 == 1 {
            i += 1;
        }
    }
    Err("wav data chunk missing".into())
}
