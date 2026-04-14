# bro

Unified async MCP server for multi-provider agent orchestration.

Launch Claude, Codex, Vibe (Devstral), or Gemini as background agents through a single MCP interface. The `exec`/`wait` pattern solves the MCP timeout problem — `exec` returns immediately, `wait` blocks until the agent finishes.

## Install

```bash
git clone https://github.com/invidious9000/bro.git
cd bro
npm install
```

## Configure

### Claude Code (project-level)

`.mcp.json`:

```json
{
  "mcpServers": {
    "bro": {
      "command": "npx",
      "args": ["tsx", "/path/to/bro/server.ts"]
    }
  }
}
```

### Claude Code (global)

Add to `~/.claude/.claude.json` under `mcpServers`:

```json
"bro": {
  "type": "stdio",
  "command": "npx",
  "args": ["tsx", "/path/to/bro/server.ts"]
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.bro]
command = "npx"
args = ["tsx", "/path/to/bro/server.ts"]
```

## Tools

| Tool | Description |
|------|-------------|
| `exec` | Launch an agent task. Returns `{taskId, sessionId}` immediately. |
| `wait` | Block until a task completes. Returns normalized result. |
| `resume` | Continue a previous session with a follow-up prompt. |
| `status` | Non-blocking progress check. |
| `cancel` | Kill a running task (SIGTERM). |
| `providers` | List configured providers and whether their binaries are found. |
| `dashboard` | List recent tasks/sessions. Look up forgotten taskIds. |

## Usage pattern

```
exec(provider, prompt) -> {taskId, sessionId}
wait(taskId)           -> {result, usage, elapsed, ...}
```

The `wait` tool description instructs the LLM to use maximum timeout and not cancel early. This is the key mechanism — splitting launch from join means the LLM doesn't prematurely abandon long-running agent work.

For follow-ups on the same conversation:

```
resume(sessionId, provider, prompt) -> {taskId, sessionId}
wait(taskId)                        -> {result, ...}
```

## Providers

| Provider | Binary | Resume | Session discovery |
|----------|--------|--------|-------------------|
| `claude` | `claude` | Yes | Pre-assigned UUID |
| `codex` | `codex` | Yes | From `thread.started` event |
| `vibe` | `vibe` | Yes | Post-hoc from `~/.vibe/logs/session/` |
| `gemini` | `gemini` | Yes | From JSON output `session_id` field |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI |
| `CODEX_BIN` | `codex` | Path to Codex CLI |
| `VIBE_BIN` | `vibe` | Path to Vibe CLI |
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI |
| `BRO_STORE` | `~/.bro` | Task persistence directory |
| `BRO_EXTRA_PATH` | `~/.local/bin` | Prepended to PATH for spawned processes |
| `BRO_TASK_TTL_MS` | `86400000` (24h) | How long completed tasks are retained |
| `VIBE_SESSION_DIR` | `~/.vibe/logs/session` | Where Vibe writes session logs |

## How it works

Each provider has a spawn config that translates `exec`/`resume` into the correct CLI flags and a parser that normalizes provider-specific output into a common shape:

```json
{
  "taskId": "uuid",
  "provider": "claude",
  "sessionId": "uuid",
  "status": "completed",
  "elapsed": "12s",
  "result": "the agent's final response",
  "usage": { "input_tokens": 1234, "output_tokens": 567 },
  "costUsd": 0.04
}
```

Task state is persisted to disk and survives server restarts. Running tasks from a previous server lifetime are marked as failed on reload.

## License

MIT
