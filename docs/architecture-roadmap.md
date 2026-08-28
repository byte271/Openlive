# OpenLive architecture roadmap (v26.7.16)

This document captures the target architecture beyond the current voice+tools MVP.
**Baseline release:** [26.7.16](release-26.7.16.md) · Parity: [gpt-live-parity.md](gpt-live-parity.md)

## Now (implemented foundation — 26.7.16)

- Deterministic tools: `web_search`, `deep_search`, `research_pool`, `calculator`, `get_time`, `identity`, sandbox `list/read/write_file`
- Typo correction for ASR/search
- Open-source **Piper TTS** status + install command + speak endpoint (demo path: neural or silence)
- Session **memory** JSON store + export API + inject into LLM context
- Thought depth setting (voice / balanced / deep) — drives reply length + deep research pool
- Agent routing that does **not** force-search every sentence
- **Multi-agent pool** `POST /v1/agent/pool` (≤50 workers, default 4 search agents)
- **Sandbox workspace** under `%LOCALAPPDATA%\openlive\sandbox` + Settings UI file list
- **Model HTTP status codes** on `/v1/agent/run` and `/v1/llm/*` errors (`model_status`, `http_status`)
- **Built-in LLM provider catalog** (12 providers) usable before gateway connection
- **Coordinated WebRTC → WebSocket fallback** with re-entry guard and retry cap
- **Desktop shell** (Tauri v2) for Windows MSI and macOS DMG/App
- **Full-screen voice mode** with hover-to-reveal chrome and `F` shortcut
- **Call-first Bloub surface** + Morphicons controls + Advanced lab disclosure
- Ripple feedback and sheet motion without a forced branded splash

## Next

### Sandbox workspace (`sandbox/`)

| Area | Status |
|------|--------|
| `sandbox/workspace` files | Done — path-safe CRUD |
| Settings file browser | Done — list/refresh |
| `sandbox/browser` | HTTP + multi-page + dump-dom + screenshots + PDF + media gallery |
| `sandbox/test` runner | Done — `POST /v1/sandbox/test/run` self-tests |
| `sandbox/lab` | Done — `GET /v1/sandbox/lab` status + dirs |

### Multi-agent runtime

- [x] Up to **50 concurrent agents** (`agent_pool`, hard cap)
- [x] Parallel search workers + synthesis
- [x] Per-agent memory slice / tool allow-list classes (`general|researcher|coder|safe`)
- [x] Live UI for pool progress (research strip while deep/pool runs)
- [x] SSE stream `GET /v1/agent/pool/events?id=`
- [x] Background pool start `POST /v1/agent/pool/start` + deep voice path with live progress
- [x] Settings **Demo deep pool** button (SSE + poll)
- [x] Lab notes via `save_note` tool

### Depth of thought

| Mode | Tokens | Style |
|------|--------|--------|
| `voice` | low | 1–2 short spoken sentences |
| `balanced` | medium | clear multi-sentence answers |
| `deep` | high | research pool + multi-angle search |

### Deep research

- [x] Multi-angle `deep_search` + `research_pool`
- [x] Citation cards in transcript (`sources[]` + visual card)
- [x] Source notes pinned into memory automatically

### Interactive UI

- [x] Piper install modal, sandbox panel, memory export
- [x] Live multi-agent progress strip
- [x] Confirm dialogs for destructive sandbox write/delete (`needs_confirm` + modal)
- [x] Live pool status poll `GET /v1/agent/pool/status?id=`
- [x] Multi-turn session context (server ring + client transcript prior)
- [x] Durable user profile (name/facts/timezone/voice prefs) — `GET|POST /v1/profile`
- [x] Profile ↔ Settings sync (hydrate + save prefs)
- [x] Profile editor form (name / timezone / notes / facts)
- [x] Per-fact remove + clear-all facts UI/API
- [x] Per-fact edit + reorder (↑/↓) UI/API
- [x] Drag-and-drop fact reorder + `POST /v1/profile/facts/reorder`
- [x] Agent tools `get_profile` / `remember_fact` + “what do you know about me”

- [x] Agent class / pool chips on result toasts

## Safety

- Sandbox never has unrestricted host FS access
- [x] Tool allow-lists per agent class
- [x] User confirm for destructive overwrite/delete (UI + voice yes/no)
