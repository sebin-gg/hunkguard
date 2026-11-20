# HunkGuard

A small VS Code extension whose agent loop runs entirely on a **local [TrueForge](https://github.com/truefoundry/trueforge)** server. The agent explores your workspace through editor MCP tools, proposes edits as **per-hunk diffs**, and nothing touches disk until you accept each hunk.

Built for the TrueFoundry Forge-a-thon (Team `sebin-gg`).

## Architecture

```
VS Code ──webview panel──► HunkGuard extension ──HTTP/SSE──► TrueForge (localhost:8790)
     ▲                        │                                    │
     │                        │ hosts MCP server (127.0.0.1)       │ agent loop,
     │                        ▼                                    │ model calls,
     │                  hunkguard-editor MCP                        │ approvals,
     │                  (workspace_search, list_files,              │ streaming
     │                   read_file, propose_write, run_command)     │
     └── per-hunk accept/reject ◄── PendingStore (overlay reads, no disk writes)
```

- **TrueForge owns** sessions, model calls, the agent/tool loop, streamed events, and tool approvals. The extension is a pure client — it never calls a model provider directly and contains no second agent loop.
- **`propose_write` never writes.** It records a proposal; `read_file` shows the proposed state as an overlay so the agent sees its own pending edits. Hunks become real file changes only when you click **Accept** (applied via `WorkspaceEdit`, so Ctrl+Z undoes them).
- **Stop** calls `POST /sessions/{id}/cancel` and discards proposals created by that turn — no partial writes.
- **Model failure**: primary model → configured fallbacks; rate limits retry with backoff. All failures surface as panel errors; the editor stays responsive and failed turns leave zero disk changes.
- **Low-end mode** (`hunkguard.lowEndMode`): caps auto-context at ~4k tokens, shrinks read/search bounds — for 4–8k-context local models and weak laptops.

## Requirements

- VS Code ≥ 1.90, Node ≥ 22.14 (for TrueForge)
- TrueForge running locally: `npx @truefoundry/trueforge@latest`
- A tool-capable model configured in TrueForge (we use a free OpenAI/Anthropic-compatible endpoint)

### TrueForge setup (one time)

TrueForge's MCP client blocks loopback hosts by default. Start it with a narrow allowlist (it still binds to localhost only — nothing is exposed):

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

Configure a model provider in TrueForge settings (`/api/v1/settings/model-providers`) pointing at your endpoint, then set `hunkguard.model` to `provider/model-name`.

## Install (development)

```bash
pnpm install
pnpm run compile     # esbuild -> dist/extension.js
pnpm test            # vitest: diff/hunk/staleness/retrieval/workspace-safety
code --extensionDevelopmentPath=D:\git\hunkguard D:\git\flask
```

Commands: `HunkGuard: Open Agent Panel`, `HunkGuard: Edit Selection with Agent` (`Ctrl+Alt+K`), `Stop`, `Accept/Reject All`, `Undo Last`.

## Headless rehearsal (no VS Code)

```bash
pnpm exec esbuild src/headless.ts --bundle --platform=node --format=cjs --outfile=dist/headless.cjs
node dist/headless.cjs D:\git\flask "your task prompt"
```

Runs the same MCP server + proposal pipeline against TrueForge and auto-accepts hunks at the end.

## Tasks demonstrated (Flask 3.1.3, commit 22d92470)

- **A — Inline edit**: select `get_debug_flag`, instruct via `Ctrl+Alt+K`, review/accept hunks.
- **B — Agent mode**: panel prompt adds `flask config` CLI command (≥3 files), verified with `pytest tests/test_cli.py -q`.
- **C — Resilience**: unreachable/invalid provider → clear error, editor responsive, `git status` clean.

## AI tools used

Devin (Cognition) for implementation assistance. TrueForge (TrueFoundry) as the agent runtime. Models via a free coarena.ai endpoint (`deepseek-v4-1-flash`, `gemini-3-8-flash`, `gpt-6-luna`).

## License

MIT
