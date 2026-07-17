# Third-party notices & credits

OpenLive (Apache-2.0) incorporates ideas, APIs, and optional integrations from
the open-source projects below. **Respect each project's license** when you
redistribute binaries, models, or Docker images that bundle them.

This file is the authoritative credit list for **v26.7.16**.

---

## Native duplex speech

| Project | License | Use in OpenLive |
|---------|---------|-----------------|
| **[Kyutai Moshi](https://github.com/kyutai-labs/moshi)** | Apache-2.0 | Product category for native full-duplex; OpenLive ships an original WebSocket adapter (`moshi` provider). Model weights are **not** redistributed. |

## AI voice (TTS)

| Project | License | Use in OpenLive |
|---------|---------|-----------------|
| **[Piper](https://github.com/OHF-Voice/piper1-gpl)** (OHF-Voice / Rhasspy lineage) | GPL-3.0 | Recommended neural TTS via OpenAI-compatible servers |
| **[openedai-speech](https://github.com/matatonic/openedai-speech)** | AGPL-3.0 (check repo) | Optional OpenAI `/v1/audio/speech` front-end for Piper / Coqui |
| **[LocalAI](https://github.com/mudler/LocalAI)** | MIT | Optional all-in-one OpenAI-compatible ASR/LLM/TTS host |
| **[Coqui TTS / XTTS](https://github.com/coqui-ai/TTS)** (historical) | MPL-2.0 / various | Optional high-quality TTS backend behind compatible servers |

OpenLive does **not** ship Piper model weights. Operators download voices under
the Piper project's terms.

---

## ASR & language models

| Project | License | Use |
|---------|---------|-----|
| **[OpenAI Whisper](https://github.com/openai/whisper)** / **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** | MIT | Typical ASR backends for the cascade provider |
| Any OpenAI-compatible LLM server (Ollama, vLLM, llama.cpp, …) | Varies | Cascaded chat completions |

---

## Client audio intelligence

| Project / lineage | License | Use in OpenLive |
|-------------------|---------|-----------------|
| **[RNNoise](https://github.com/xiph/rnnoise)** (Xiph / Jean-Marc Valin) | BSD-3-Clause | Frame size (10 ms / 480 @ 48 kHz) and spectral noise-suppression approach; in-tree Wiener worklet is an original implementation inspired by this design |
| **[Silero VAD](https://github.com/snakers4/silero-vad)** | MIT | Frame timing (~32 ms) and VAD product category; in-tree spectral/energy worklet is original JS, ONNX weights not bundled |
| **NLMS adaptive filtering** | Classical DSP (public domain algorithms) | In-tree `NlmsAec` for acoustic echo cancellation |
| **Windowed-sinc resampling** | Classical DSP | In-tree polyphase-style FIR resampler |

When official RNNoise WASM or Silero ONNX runtimes are vendored under
`apps/openlive-gateway/web/vendor/`, retain their LICENSE files beside the
binaries and update this notice.

---

## Transport & protocol inspiration

| Project / spec | Notes |
|----------------|-------|
| OpenAI Realtime API (public docs) | Event shape compatibility for the optional realtime provider — not an inclusion of OpenAI code |
| WebRTC (W3C / IETF) | Browser `RTCPeerConnection` path for low-latency media |
| **[webrtc-rs](https://github.com/webrtc-rs/webrtc)** | MIT/Apache-2.0 pure-Rust WebRTC stack used by the gateway-native peer hub |

## Desktop shell

| Project | License | Use in OpenLive |
|---------|---------|-----------------|
| **[Tauri](https://tauri.app/)** | MIT / Apache-2.0 | v2 desktop shell for Windows (MSI) and macOS (DMG/App) in `apps/openlive-desktop` |

---

## Fonts (web UI)

| Family | Source | License |
|--------|--------|---------|
| **DM Sans**, **Manrope**, **Space Mono**, **Inter** (if loaded) | [Google Fonts](https://fonts.google.com/) | OFL / respective font licenses |

---

## Rust ecosystem

OpenLive depends on crates declared in `Cargo.lock` (Tokio, Axum, Serde, …).
Run `cargo license` (optional) for a full machine-readable inventory. Workspace
license is **Apache-2.0**.

---

## Attribution requirements (summary)

1. **Apache-2.0 (OpenLive)** — include this NOTICE and the LICENSE file.
2. **GPL/AGPL components (Piper, some speech servers)** — if you **distribute** a
   combined binary/image that statically links GPL code, your distribution may
   need to comply with GPL terms. Preferred pattern: run Piper **out-of-process**
   over HTTP so OpenLive remains Apache-2.0 and the speech server stays separate.
3. **MIT/BSD** — retain copyright notices when redistributing source or substantial portions.

---

## Contact

For credit corrections or additional notices, open an issue or PR against the
OpenLive repository.
