# OpenLive sandbox (v26.7.15)

Isolated workspace for multi-agent tools. Paths are confined to the sandbox root
(typically `%LOCALAPPDATA%\openlive\sandbox` on Windows). See
`docs/architecture-roadmap.md` and `docs/release-26.7.15.md`.

```
sandbox/
  browser/              # browse_url / browse_site + optional Chrome/Edge dump-dom
  workspace/            # agent-writable files
  workspace/lab/        # save_note research notes
  workspace/lab/screenshots/  # PNG from screenshot_url
  workspace/lab/pdfs/         # PDF from print_pdf
  files/                # workspace file manager layout (UI)
  test/                 # self-test runner target
  lab/                  # experimental agent notes
```

## HTTP API (gateway)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/sandbox/status` | Root path + readiness |
| POST | `/v1/sandbox/list` | List relative path |
| POST | `/v1/sandbox/read` | Read file |
| POST | `/v1/sandbox/write` | Write file (may `needs_confirm`) |
| POST | `/v1/sandbox/delete` | Delete file (may `needs_confirm`) |
| POST | `/v1/sandbox/browse` | Fetch / dump-dom page text |
| POST | `/v1/sandbox/screenshot` | Headless screenshot (Chrome/Edge if present) |
| POST | `/v1/sandbox/pdf` | Headless PDF |
| GET | `/v1/sandbox/media` | List captured media |
| POST | `/v1/sandbox/media/read` | Read media blob metadata/path |
| GET | `/v1/sandbox/browser/status` | Headless browser availability |
| GET | `/v1/sandbox/lab` | Lab dirs status |
| POST | `/v1/sandbox/test/run` | Sandbox self-tests |

## Safety

- No unrestricted host filesystem access.
- Destructive overwrite/delete goes through pending confirm (`/v1/agent/confirm`).
- Agent classes restrict tool allow-lists (`general` | `researcher` | `coder` | `safe`).
- Multi-agent pool hard-capped at **50** concurrent workers.
