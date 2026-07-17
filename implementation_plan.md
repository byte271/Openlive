# OpenLive → GPT-Live Parity — Implementation Plan

**Status date:** 2026-07-15  
**Baseline:** **26.7.16** (Live Presence + open voice stack)  
**Goal:** Model-neutral, open, production-grade competitor to OpenAI GPT-Live / Advanced Voice Mode.

---

## Target architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BROWSER CLIENT                                      │
│  RNNoise WASM → Silero VAD → Emotion Detect → WebGL Orb                     │
│  Enhanced AudioSession (FIR resample, NLMS AEC, client endpointing)         │
│  WebRTC (Opus) ← fallback WebSocket Binary PCM                              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────────┐
│  GATEWAY: WebRTC signaling · Semantic endpointing · MCP · Safety · Chronos  │
│  Providers: Mock · Cascade · Realtime · Moshi · HybridStreaming             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase status

### Phase 1: Client-Side Intelligence & Audio Quality — **DONE (v26.7.16)**

| Item | Status | Notes |
|------|--------|-------|
| RNNoise suppression worklet | **Done (JS Wiener)** | Credited RNNoise lineage; WASM swap-in ready |
| Silero VAD worklet | **Done (spectral JS)** | Credited Silero lineage; ONNX path stubbed |
| NLMS adaptive AEC | **Done** | `NlmsAec` in `audio-utils.js` |
| Polyphase / windowed-sinc FIR resampler | **Done** | `audio-utils.js` |
| Chain in AudioSession | **Done** | mic → RNNoise → Silero → capture → NLMS → FIR → PCM16 |
| Open AI voice (Piper) | **Done** | Piper-first roster + cascade docs; formant mock |
| UI Live Presence | **Done** | Default theme + credits panel |
| THIRD_PARTY_NOTICES | **Done** | Root notices file |

### Phase 2: WebRTC / Opus Transport — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| `/v1/realtime/session` + client secret | **Done** | Gateway route + `create_client_secret` on provider trait |
| Browser RTCPeerConnection + `oai-events` | **Done** | `app.js` offer/answer with OpenAI Realtime SDP |
| Silent renegotiation on disconnect | **Done** | Token expiry / disconnect → `silentWebRtcReconnect` |
| Deep PLC + jitter enhancements | **Done** | Stats jitter + pitch-period PLC in playback worklet |
| ICE config endpoint | **Done** | `GET /v1/webrtc/ice` STUN roster |
| SDP offer scaffold | **Done** | `POST /v1/webrtc/offer` |
| Gateway-native WebRTC (webrtc-rs) | **Done** | ICE/DTLS + data channels for events/PCM media |
| Client gateway WebRTC path | **Done** | Prefer native hub when `gateway_webrtc` |
| WebRTC Chronos/endpointing bridge | **Done** | Auto-commit + ASR final + capabilities |
| RTP Opus tracks | **Todo** | Optional; data-channel PCM is the production path for now |

### Phase 3: Semantic Endpointing & Transcript Revision — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Client `webkitSpeechRecognition` → transcript deltas | **Done** | `app.js` |
| Semantic completeness + 200 ms early endpoint | **Done** | `openlive-audio` `observe_with_semantic`; session wiring |
| Cascade overlapping windows / ASR revisions | **Done** | ~400 ms prior PCM prepend on cascade commit |
| Chronos in-place transcript revisions + UI anim | **Done** | `reviseText` + `.bubble-revise` flash |

### Phase 4: Native Duplex (Moshi) — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Moshi WebSocket adapter | **Done** | `moshi.rs` + `--provider moshi` |
| Multi-model Fast / Deep cognition | **Done** | `--deep-llm-model` + heuristic router |

### Phase 5: Safety, MCP, Retrieval, Agent workspace — **PARTIAL (strong in 26.7.16)**

| Item | Status | Notes |
|------|--------|-------|
| Streaming safety holdback | **Done** | `safety.rs` + session wiring (`--safety`) |
| MCP JSON-RPC client | **Done** | `mcp_client.rs` + `/v1/mcp/tools` + `/v1/mcp/call` |
| Knowledge retrieval inject | **Done** | keyword store from `--knowledge-dir` |
| Internal agent tools + confirm | **Done** | search, calc, sandbox, browse, profile; `/v1/agent/*` |
| Multi-agent pool ≤50 + SSE | **Done** | `agent_pool`, pool jobs, classes |
| Sandbox FS + headless capture | **Done** | path-safe I/O; Chrome/Edge dump-dom/shot/PDF |
| Durable profile + memory | **Done** | `/v1/profile`, `/v1/memory`, facts DnD |
| Embedding vector DB | **Todo** | swap behind KnowledgeStore API |
| Tool authz audit suite | **Todo** | multi-tenant cancel/audit soak |

### Phase 6: Deadlines & Session Limits — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Unlimited session cap UI default | **Done** | Settings `sessionCap=0` |
| WebRTC token refresh / renegotiate | **Done** | Client-side |
| Configurable `DEFAULT_TASK_DEADLINE_MS` | **Done** | `--task-deadline-ms` + atomic override |
| Durable session persistence | **Done** | JSONL store (`data/openlive-sessions`, SQLite-shaped API) |

### Phase 7: Visualization & UI — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| `chatgpt` theme + CSS variables | **Done** | `styles.css`, `settings-store.js` |
| Wave-Particle orb (Canvas 2D) | **Done** | `voice-visualizer.js` Bezier blobs + particle ring |
| Boot splash + live status | **Done** | `app.js` + `index.html` + `styles.css` |
| Full-screen voice mode | **Done** | Settings toggle, `F` shortcut, exit button |
| Ripple click feedback + loading states | **Done** | `app.js` + `styles.css` |
| Page-load / sheet / button / toast animations | **Done** | `styles.css` v26.7.16 animation section |
| Three.js WebGL Icosphere + GLSL | **Todo** | |

### Phase 8: Emotion-Aware Responses — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Emotion feature extraction | **Done** | `emotion-detector.js` valence/arousal |
| Modulate barge-in / pause | **Done** | Wired in `audio-session` local duck thresholds |
| Provider emotion-conditioned replies | **Todo** | Needs LLM system hint injection |

### Phase 9: Full-Duplex Benchmarking — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| `openlive-full-duplex-bench` | **Done** | Local Chronos commit latency gate |
| VoiceBench dataset harness | **Todo** | |

### Phase 10: Provider UI & Developer API — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Provider chip + enriched `/v1/providers` | **Done** | Features map, recommended Piper voices |
| Provider catalog | **Done** | `GET /v1/providers/catalog` + `--provider hybrid` |
| Built-in provider catalog (offline setup) | **Done** | 12 providers in `app.js` BUILTIN_PROVIDER_DETAILS |
| Developer REST (`/health` JSON, `/v1/meta`, `/v1/sessions`, `/v1/tasks`) | **Done** | Optional `OPENLIVE_API_KEY` |
| Transcript export | **Done** | Client JSON export + `GET /v1/sessions/{id}/transcript` |
| VisualCard + live translation (mock) | **Done** | Protocol rev 4; language chip injects translate mode |
| Multi-process provider hot-swap UI | **Todo** | Restart with `--provider` still required |

### Phase 11: Desktop & Distribution — **PARTIAL**

| Item | Status | Notes |
|------|--------|-------|
| Tauri v2 shell | **Done** | `apps/openlive-desktop/` Windows MSI + macOS DMG/App |
| Gateway child-process spawn | **Done** | `main.rs` waits for health, kills on exit |
| Auto-updater / code signing | **Todo** | |
| Linux AppImage / Flatpak | **Todo** | |

---

## Shipped in working tree as of 26.7.16

- WebRTC signaling + gateway-native data-channel path + browser peer
- Semantic VAD hybrid + cascade ASR prior window + revise UI
- Live Presence / minimal-black UI + Piper TTS + formant fallback
- Agent tools, multi-agent pool, sandbox, profile/memory, confirms
- Version surface: Cargo / UI / living docs all **26.7.16**

---

## Verify

```bash
# Rust unit tests (release)
cargo test --workspace --release

# Integration tests need a debug binary:
cargo test --workspace

# Frontend JS unit tests
node --test apps/openlive-gateway/web/tests/*.test.js
```

---

## Recommended next session order

1. **Phase 2 Opus RTP** — optional media tracks + impairment harness  
2. **Phase 1 polish** — optional RNNoise WASM / Silero ONNX vendor weights  
3. **Transcript editing** — last soft GAP on the voice surface  
4. **Tool authz audit / soak** — production-depth gates on agent sandbox  
5. **Benchmark qualification** — Full-Duplex-Bench / VoiceBench manifests
6. **Phase 4 Moshi** — true native duplex  
7. **Phases 7–10** — WebGL orb, emotion, benches, developer API  

---

## File map (Phase 1 + prior handoff)

| Path | Role |
|------|------|
| `apps/openlive-gateway/web/audio-utils.js` | FIR resample, NLMS AEC, echo correlator |
| `apps/openlive-gateway/web/rnnoise-worklet.js` | Spectral NS worklet |
| `apps/openlive-gateway/web/silero-vad-worklet.js` | Client VAD worklet |
| `apps/openlive-gateway/web/audio-session.js` | Capture graph + NLMS + blend |
| `apps/openlive-gateway/web/app.js` | WebRTC + speech recognition |
| `apps/openlive-gateway/web/voice-visualizer.js` | ChatGPT orb |
| `apps/openlive-gateway/src/main.rs` | `/v1/realtime/session` |
| `crates/openlive-audio/src/lib.rs` | Semantic endpointing |
| `crates/openlive-provider/src/openai_realtime.rs` | Client secret minting |
