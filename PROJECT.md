# bro — Project Instructions

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Run the daemon (`tsx server.ts`) — listens on `http://127.0.0.1:$BRO_PORT/mcp` |
| `npm run lint` | Type-check with `tsc --noEmit` |

No build step — tsx runs TypeScript directly. No test framework configured. No formatter/linter beyond tsc.

## Architecture

Single-file HTTP SSE MCP server (`server.ts`) that solves MCP tool timeouts by splitting agent launch from result collection. Runs as a centralized daemon — multiple MCP clients connect via HTTP, sharing the same task/team state. Each client gets its own MCP session, but all sessions share module-level state.

### Core Concepts

- **Provider**: A CLI agent backend (claude, codex, copilot, vibe, gemini)
- **Brofile**: A reusable template defining {provider, account, lens/personality}
- **Bro instance**: A named runtime instance of a brofile, tracks its own sessionId and task history
- **Teamplate**: An ensemble blueprint — a list of brofile slots
- **Team**: An instantiated teamplate — a collection of named bro instances
- **Broadcast**: Fan-out a prompt to all team members
- **when_all / when_any**: Fan-in — await all or race to first completion

### Provider Registry

Each provider (claude, codex, copilot, vibe, gemini) is a `ProviderConfig` with:
- `bin` / env var override (e.g. `CLAUDE_BIN`) for the CLI path
- `buildExecArgs()` / `buildResumeArgs()` — construct CLI invocation
- `parseEvent()` — normalize provider-specific output into common Task shape
- `extractSessionId()` — session discovery varies per provider

### Task Lifecycle

1. **exec** spawns a child process, returns `{taskId, sessionId}` immediately
2. Process output collected as events (streaming JSON for claude/codex/copilot, bulk JSON on close for vibe/gemini)
3. `parseEvent()` extracts `lastAssistantMessage`, `usage`, `costUsd`, `sessionId` from raw events
4. **wait** resolves when task status leaves "running" — returns normalized result
5. **resume** continues a prior session via `buildResumeArgs(sessionId, prompt)`

### Brofile / Team Layer

- **Brofiles** define agent personalities: provider + account + optional lens (system prompt)
- **Accounts** registry in `~/.bro/config.json` maps account names to env var overrides (e.g. `CLAUDE_HOME`)
- **Teamplates** define ensemble compositions — which brofiles, how many instances each
- **Teams** are instantiated teamplates with live bro instances tracking sessionIds
- Resolution chain: project-local (`.bro/`) overrides global (`~/.bro/`) for brofiles and teamplates
- Teams are always global (they reference live sessions)

### Ensemble Primitives

- **broadcast(team, prompt)**: Sends prompt to all team members. Resumes existing sessions, starts fresh for new members
- **when_all(team | task_ids)**: Blocks until all tasks complete, returns collected results
- **when_any(team | task_ids)**: Blocks until first task completes, returns all current states

### Transport

HTTP SSE via `StreamableHTTPServerTransport`. Stateful sessions — each client gets a session ID on initialize. Multiple clients share the same daemon process. Port configurable via `BRO_PORT` (default 7263). Runs as a systemd user service (`~/.config/systemd/user/bro.service`).

### Disk Persistence

```
~/.bro/
  config.json           # Accounts registry
  tasks.json            # Task state (24h TTL, last 50 events per task)
  brofiles/             # Global brofile templates
  teamplates/           # Global teamplate definitions
  teams/                # Active team instances

<project>/.bro/
  brofiles/             # Project-local brofiles (override global)
  teamplates/           # Project-local teamplates (override global)
```

Atomic writes (write `.tmp`, rename). Running tasks marked failed on server restart.

### MCP Tools (12 total)

**Core orchestration (6):**
- `exec` — launch task targeting a named bro or raw provider
- `resume` — continue session by bro name (auto-resolves sessionId) or raw session_id + provider
- `wait` — block until single task completes
- `when_all` — block until all tasks complete (team or task_ids)
- `when_any` — block until first task completes (team or task_ids)
- `broadcast` — fan-out prompt to all team members

**Operational (4):**
- `status` — non-blocking progress check
- `dashboard` — list recent tasks (filterable by provider, team, status)
- `cancel` — kill a running task
- `providers` — list configured providers

**Meta (2 — subcommand CRUD):**
- `brofile` — actions: create, list, get, delete, set_account, list_accounts
- `team` — actions: save_template, list_templates, delete_template, create, list, dissolve, roster

Tool descriptions are LLM-facing instructions — edit carefully as they directly affect how calling LLMs use the tools.

## Key Design Decisions

- **HTTP SSE daemon**: Centralized process, multiple MCP clients share state. No split-brain, no disk races.
- **Named bro as session handle**: Callers target bros by name instead of juggling raw sessionIds. The system resolves provider, account, lens, and sessionId automatically.
- **Hub-and-spoke coordination**: The orchestrating LLM mediates all communication. Bros never talk to each other directly. No inbox system needed.
- **Lens injection**: System prompt / personality prepended to the user prompt via `applyLens()`. Stacks with the anti-recursion guard.
- **Anti-recursion guard**: All prompts get a system instruction prepended telling the spawned agent not to call bro tools. Disabled per-call via `allow_recursion: true`.
- **Project-local overrides**: Brofiles and teamplates can live in `<project>/.bro/` and override global definitions on name collision.
- **WhenAll/WhenAny over gather**: Separate tools with distinct semantics, mirroring TPL's `Task.WhenAll`/`Task.WhenAny`. Both accept team names or raw task_id arrays.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRO_PORT` | `7263` | HTTP daemon port |
| `CLAUDE_BIN` | `claude` | Claude CLI path |
| `CODEX_BIN` | `codex` | Codex CLI path |
| `COPILOT_BIN` | `gh` | GitHub CLI path (copilot subcommand) |
| `VIBE_BIN` | `vibe` | Vibe CLI path |
| `GEMINI_BIN` | `gemini` | Gemini CLI path |
| `BRO_STORE` | `~/.bro` | Persistence directory |
| `BRO_EXTRA_PATH` | `~/.local/bin` | Prepended to PATH for spawned processes |
| `BRO_TASK_TTL_MS` | `86400000` | Task retention (ms) |
| `VIBE_SESSION_DIR` | `~/.vibe/logs/session` | Vibe session log directory |

## Client Configuration

MCP clients connect via URL (not stdio):

```json
{
  "mcpServers": {
    "bro": {
      "url": "http://127.0.0.1:7263/mcp"
    }
  }
}
```

The daemon must be running before clients connect. Start with `npm start` or managed via systemd.
