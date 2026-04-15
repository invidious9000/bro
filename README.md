# bro

Multi-provider agent orchestration via MCP. Launch Claude, Codex, GitHub Copilot, Vibe (Devstral), or Gemini as background agents, organize them into named teams, and coordinate ensemble workflows.

## Install

```bash
git clone https://github.com/invidious9000/bro.git
cd bro
npm install
```

## Run

Bro runs as an HTTP daemon. Start it once, connect multiple MCP clients.

```bash
npm start
# bro daemon listening on http://127.0.0.1:7263/mcp
```

### Systemd (Linux — start on boot)

```bash
# Create user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/bro.service << 'EOF'
[Unit]
Description=bro MCP daemon — multi-provider agent orchestration
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/bro
ExecStart=/usr/bin/node /path/to/bro/node_modules/tsx/dist/cli.mjs /path/to/bro/server.ts
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now bro.service

# Survive reboots without login
loginctl enable-linger $USER

# Check status / tail logs
systemctl --user status bro
journalctl --user -u bro -f
```

## Configure MCP Clients

All clients connect via URL (not stdio):

### Claude Code

`~/.claude/.claude.json` under `mcpServers`:

```json
"bro": {
  "url": "http://127.0.0.1:7263/mcp"
}
```

Or use the CLI:

```bash
claude mcp remove bro
claude mcp add --transport http bro http://127.0.0.1:7263/mcp
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.bro]
url = "http://127.0.0.1:7263/mcp"
```

## Tools

### Core Orchestration

| Tool | Description |
|------|-------------|
| `exec` | Launch a task targeting a named bro or raw provider. Returns `{taskId}` immediately. |
| `resume` | Continue a session by bro name (auto-resolves sessionId) or raw session_id + provider. |
| `wait` | Block until a single task completes. |
| `broadcast` | Send the same prompt to every member of a team. |
| `when_all` | Block until ALL tasks complete (team or task_ids). |
| `when_any` | Block until the FIRST task completes (team or task_ids). |

### Operational

| Tool | Description |
|------|-------------|
| `status` | Non-blocking progress check. |
| `dashboard` | List recent tasks (filterable by provider, team, status). |
| `cancel` | Kill a running task (SIGTERM). |
| `providers` | List configured providers and binary availability. |

### Management (subcommand CRUD)

| Tool | Actions |
|------|---------|
| `brofile` | `create`, `list`, `get`, `delete`, `set_account`, `list_accounts` |
| `team` | `save_template`, `list_templates`, `delete_template`, `create`, `list`, `dissolve`, `roster` |

## Concepts

**Brofile** — a reusable template: provider + account + lens (personality/system prompt).

**Bro instance** — a named runtime agent created when a team is instantiated. Tracks its own sessionId and task history. Target by name: `exec(bro: "alice", prompt: ...)`.

**Teamplate** — an ensemble blueprint listing brofile slots.

**Team** — an instantiated teamplate. Broadcast to it, when_all/when_any on it.

## Usage

### Ad-hoc (raw provider)

```
exec(provider: "claude", prompt: "...") -> {taskId, sessionId}
wait(taskId)                            -> {result, usage, ...}
```

### Named bro workflow

```
# Setup
brofile(action: "create", name: "reviewer", provider: "claude", lens: "You are a senior code reviewer.")
brofile(action: "create", name: "adversary", provider: "gemini", lens: "You are a devil's advocate.")
team(action: "save_template", name: "review-panel", members: [{brofile: "reviewer"}, {brofile: "adversary"}])
team(action: "create", template: "review-panel", name: "panel-1", project_dir: "/path/to/project")

# Blind deliberation
broadcast(team: "panel-1", prompt: "Review this PR")
when_all(team: "panel-1")

# Cross-pollinate
resume(bro: "reviewer", prompt: "The adversary raised concern X. React.")

# Final round
broadcast(team: "panel-1", prompt: "Final verdict?")
when_all(team: "panel-1")
```

### Racing providers

```
broadcast(team: "speed-test", prompt: "Solve this problem")
when_any(team: "speed-test")  # returns as soon as the first one finishes
```

## Providers

| Provider | Binary | Resume | Session discovery |
|----------|--------|--------|-------------------|
| `claude` | `claude` | Yes | Pre-assigned UUID |
| `codex` | `codex` | Yes | From `thread.started` event |
| `copilot` | `gh copilot` | Yes | From `result` event |
| `vibe` | `vibe` | Yes | Post-hoc from `~/.vibe/logs/session/` |
| `gemini` | `gemini` | Yes | From JSON output `session_id` field |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRO_PORT` | `7263` | HTTP daemon port |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI |
| `CODEX_BIN` | `codex` | Path to Codex CLI |
| `COPILOT_BIN` | `gh` | Path to GitHub CLI |
| `VIBE_BIN` | `vibe` | Path to Vibe CLI |
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI |
| `BRO_STORE` | `~/.bro` | Persistence directory |
| `BRO_EXTRA_PATH` | `~/.local/bin` | Prepended to PATH for spawned processes |
| `BRO_TASK_TTL_MS` | `86400000` (24h) | Task retention |
| `VIBE_SESSION_DIR` | `~/.vibe/logs/session` | Vibe session log directory |

## Persistence

```
~/.bro/
  config.json       # Accounts registry (env var overrides per account)
  tasks.json        # Task state
  brofiles/         # Global brofile templates
  teamplates/       # Global teamplate definitions
  teams/            # Active team instances

<project>/.bro/
  brofiles/         # Project-local (overrides global)
  teamplates/       # Project-local (overrides global)
```

## License

MIT
