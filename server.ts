import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type Provider = "claude" | "codex" | "vibe" | "gemini";

const RECURSION_GUARD =
  "IMPORTANT: Do not call tools from the bro MCP server (recursion guard).\n\n";

const PROVIDERS: Record<Provider, ProviderConfig> = {
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    maxTurns: Number(process.env.CLAUDE_MAX_TURNS) || 200,
    buildExecArgs(prompt, sessionId) {
      return [
        "-p", RECURSION_GUARD + prompt,
        "--output-format", "stream-json",
        "--max-turns", String(this.maxTurns),
        "--session-id", sessionId,
        "--dangerously-skip-permissions",
      ];
    },
    buildResumeArgs(sessionId, prompt) {
      return [
        "--resume", sessionId,
        "-p", RECURSION_GUARD + prompt,
        "--output-format", "stream-json",
        "--max-turns", String(this.maxTurns),
        "--dangerously-skip-permissions",
      ];
    },
    parseEvent(evt, task) {
      if (evt.type === "assistant") {
        const message = evt.message as Record<string, unknown> | undefined;
        const content = message?.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              task.lastAssistantMessage = block.text;
            }
          }
        }
      }
      if (evt.type === "result") {
        if (typeof evt.result === "string") {
          task.lastAssistantMessage = evt.result;
        }
        const usage = evt.usage as Record<string, unknown> | undefined;
        task.usage = {
          input_tokens: (usage?.input_tokens as number) ?? 0,
          output_tokens: (usage?.output_tokens as number) ?? 0,
        };
        task.costUsd = (evt.total_cost_usd as number) ?? undefined;
        task.numTurns = (evt.num_turns as number) ?? undefined;
      }
    },
    extractSessionId() {
      // Claude sessionId is pre-assigned at exec time
    },
    supportsResume: true,
  },
  codex: {
    bin: process.env.CODEX_BIN || "codex",
    maxTurns: 0,
    buildExecArgs(prompt, _sessionId, cwd) {
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"];
      if (cwd) args.push("-C", cwd);
      args.push(RECURSION_GUARD + prompt);
      return args;
    },
    buildResumeArgs(sessionId, prompt) {
      return [
        "exec", "resume",
        "--dangerously-bypass-approvals-and-sandbox", "--json",
        sessionId,
        RECURSION_GUARD + prompt,
      ];
    },
    parseEvent(evt, task) {
      if (evt.type === "item.completed") {
        const item = evt.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          task.lastAssistantMessage = item.text;
        }
      }
      if (evt.type === "turn.completed" && evt.usage) {
        const u = evt.usage as Record<string, unknown>;
        task.usage = {
          input_tokens: (u.input_tokens as number) ?? 0,
          output_tokens: (u.output_tokens as number) ?? 0,
        };
      }
    },
    extractSessionId(evt, task) {
      if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
        task.sessionId = evt.thread_id;
      }
    },
    supportsResume: true,
  },
  vibe: {
    bin: process.env.VIBE_BIN || "vibe",
    maxTurns: Number(process.env.VIBE_MAX_TURNS) || 100,
    buildExecArgs(prompt) {
      return ["-p", prompt, "--output", "json", "--max-turns", String(this.maxTurns)];
    },
    buildResumeArgs(sessionId, prompt) {
      return [
        "--resume", sessionId,
        "-p", prompt, "--output", "json", "--max-turns", String(this.maxTurns),
      ];
    },
    parseEvent(evt, task) {
      if (Array.isArray(evt)) {
        const assistant = [...(evt as Array<Record<string, unknown>>)]
          .reverse()
          .find((msg) => msg?.role === "assistant");
        if (assistant && typeof assistant.content === "string") {
          task.lastAssistantMessage = assistant.content.trim();
        }
      }
    },
    extractSessionId() {
      // Vibe session discovery is post-hoc — handled in close handler
    },
    supportsResume: true,
  },
  gemini: {
    bin: process.env.GEMINI_BIN || "gemini",
    maxTurns: 0,
    buildExecArgs(prompt) {
      return ["-p", prompt, "--sandbox", "--yolo", "-o", "json"];
    },
    buildResumeArgs(sessionId, prompt) {
      return [
        "--resume", sessionId,
        "-p", prompt, "--sandbox", "--yolo", "-o", "json",
      ];
    },
    parseEvent(evt, task) {
      const obj = evt as Record<string, unknown>;
      if (typeof obj.response === "string") {
        task.lastAssistantMessage = obj.response;
      }
      if (typeof obj.session_id === "string" && task.sessionId === "pending") {
        task.sessionId = obj.session_id as string;
      }
      const stats = obj.stats as Record<string, unknown> | undefined;
      if (stats) {
        const models = stats.models as Record<string, unknown> | undefined;
        if (models) {
          const firstModel = Object.values(models)[0] as Record<string, unknown> | undefined;
          const tokens = firstModel?.tokens as Record<string, unknown> | undefined;
          if (tokens) {
            task.usage = {
              input_tokens: (tokens.input as number) ?? 0,
              output_tokens: (tokens.candidates as number) ?? 0,
            };
          }
        }
      }
    },
    extractSessionId() {},
    supportsResume: true,
  },
};

interface ProviderConfig {
  bin: string;
  maxTurns: number;
  buildExecArgs(prompt: string, sessionId: string, cwd?: string): string[];
  buildResumeArgs(sessionId: string, prompt: string): string[];
  parseEvent(evt: Record<string, unknown>, task: Task): void;
  extractSessionId(evt: Record<string, unknown>, task: Task): void;
  supportsResume: boolean;
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const STORE_DIR = process.env.BRO_STORE || join(homedir(), ".bro");
const STORE_FILE = join(STORE_DIR, "tasks.json");
const TASK_TTL_MS = Number(process.env.BRO_TASK_TTL_MS) || 24 * 60 * 60 * 1000;
const MAX_PERSISTED_EVENTS = 50;

interface PersistedTask {
  id: string;
  provider: Provider;
  sessionId: string;
  events: unknown[];
  lastAssistantMessage?: string;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number;
  numTurns?: number;
  stderr: string;
  status: Task["status"];
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  cwd?: string;
}

function persistTasks(): void {
  const records: PersistedTask[] = [];
  for (const task of tasks.values()) {
    records.push({
      id: task.id,
      provider: task.provider,
      sessionId: task.sessionId,
      events: task.events.slice(-MAX_PERSISTED_EVENTS),
      lastAssistantMessage: task.lastAssistantMessage,
      usage: task.usage,
      costUsd: task.costUsd,
      numTurns: task.numTurns,
      stderr: task.stderr.slice(-2000),
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      exitCode: task.exitCode,
      cwd: task.cwd,
    });
  }
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    const tmp = STORE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(records));
    renameSync(tmp, STORE_FILE);
  } catch {
    // best-effort
  }
}

function loadPersistedTasks(): void {
  try {
    const data = readFileSync(STORE_FILE, "utf-8");
    const records = JSON.parse(data) as PersistedTask[];
    const cutoff = Date.now() - TASK_TTL_MS;
    let needsRewrite = false;
    for (const rec of records) {
      if (rec.startedAt < cutoff) { needsRewrite = true; continue; }
      if (rec.status === "running") {
        rec.status = "failed";
        rec.completedAt = Date.now();
        rec.stderr = (rec.stderr || "") +
          "\n[bro] server restarted while task was running";
        needsRewrite = true;
      }
      tasks.set(rec.id, { ...rec, process: undefined, waiters: [] });
    }
    if (needsRewrite) persistTasks();
  } catch {
    // no file or corrupt — start fresh
  }
}

// ---------------------------------------------------------------------------
// Task tracking
// ---------------------------------------------------------------------------

interface Task {
  id: string;
  provider: Provider;
  sessionId: string;
  process?: ChildProcess;
  waiters: Array<() => void>;
  events: unknown[];
  lastAssistantMessage?: string;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number;
  numTurns?: number;
  stderr: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  cwd?: string;
}

const tasks = new Map<string, Task>();

// ---------------------------------------------------------------------------
// Vibe session discovery — scans ~/.vibe/logs/session/ for the session
// file written by the most recent run matching our project dir + timestamp
// ---------------------------------------------------------------------------

const VIBE_SESSION_DIR = process.env.VIBE_SESSION_DIR ||
  join(homedir(), ".vibe/logs/session");

function discoverVibeSession(startMs: number, projectDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(VIBE_SESSION_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => join(VIBE_SESSION_DIR, n));
  } catch {
    return null;
  }

  let resolvedProjectDir: string;
  try { resolvedProjectDir = realpathSync(projectDir); }
  catch { resolvedProjectDir = projectDir; }

  const scored = files
    .map((file) => {
      try {
        const st = statSync(file);
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const meta = (data.metadata || {}) as Record<string, unknown>;
        const env = (meta.environment || {}) as Record<string, unknown>;
        const wd = env.working_directory as string | undefined;
        let matchesDir = false;
        if (wd) {
          try { matchesDir = realpathSync(wd) === resolvedProjectDir; }
          catch { matchesDir = wd === projectDir; }
        }
        const recent = st.mtimeMs >= startMs - 2000;
        const sessionId = meta.session_id as string | undefined;
        return { file, mtimeMs: st.mtimeMs, matchesDir, recent, sessionId };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null && typeof x.sessionId === "string")
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const best =
    scored.find((x) => x.matchesDir && x.recent) ||
    scored.find((x) => x.matchesDir) ||
    scored.find((x) => x.recent);

  return best?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

function spawnTask(
  provider: Provider,
  args: string[],
  sessionId: string,
  cwd?: string,
): Task {
  const config = PROVIDERS[provider];
  const id = randomUUID();

  const spawnOpts: {
    stdio: ["ignore", "pipe", "pipe"];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (cwd) spawnOpts.cwd = cwd;

  // Extend PATH so locally-installed CLIs (vibe, gemini) are found
  const extraPath = process.env.BRO_EXTRA_PATH ||
    join(homedir(), ".local/bin");
  spawnOpts.env = {
    ...process.env,
    PATH: `${extraPath}:${process.env.PATH || ""}`,
    NO_COLOR: "1",
    TERM: "dumb",
    FORCE_COLOR: "0",
  };

  const child = spawn(config.bin, args, spawnOpts);

  const task: Task = {
    id,
    provider,
    sessionId,
    process: child,
    waiters: [],
    events: [],
    stderr: "",
    status: "running",
    startedAt: Date.now(),
    cwd,
  };

  const isStreamingJson = provider === "claude" || provider === "codex";
  let rawStdout = "";

  if (isStreamingJson) {
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        const evt = JSON.parse(line) as Record<string, unknown>;
        task.events.push(evt);
        config.parseEvent(evt, task);
        config.extractSessionId(evt, task);
      } catch {
        // non-JSON line — ignore
      }
    });
  } else {
    child.stdout?.on("data", (chunk: Buffer) => {
      rawStdout += chunk.toString();
    });
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    task.stderr += chunk.toString();
  });

  child.on("close", (code) => {
    // For non-streaming providers, parse raw stdout now
    if (!isStreamingJson && rawStdout.trim()) {
      try {
        const parsed = JSON.parse(rawStdout.trim());
        config.parseEvent(parsed, task);
      } catch {
        task.lastAssistantMessage = rawStdout.trim();
      }
    }

    // Post-hoc session discovery for vibe
    if (provider === "vibe" && task.sessionId === "pending" && task.cwd) {
      const discovered = discoverVibeSession(task.startedAt, task.cwd);
      if (discovered) task.sessionId = discovered;
    }

    task.exitCode = code;
    if (task.status !== "cancelled") {
      task.status = code === 0 ? "completed" : "failed";
    }
    task.completedAt = Date.now();
    persistTasks();
    for (const resolve of task.waiters) resolve();
    task.waiters = [];
  });

  child.on("error", (err) => {
    task.stderr += `\nspawn error: ${err.message}`;
    task.status = "failed";
    task.completedAt = Date.now();
    persistTasks();
    for (const resolve of task.waiters) resolve();
    task.waiters = [];
  });

  tasks.set(id, task);
  persistTasks();
  return task;
}

// ---------------------------------------------------------------------------
// Wait — the join primitive
// ---------------------------------------------------------------------------

function waitForTask(task: Task): Promise<void> {
  if (task.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    task.waiters.push(resolve);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(task: Task): string {
  const ms = (task.completedAt ?? Date.now()) - task.startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function taskResult(task: Task): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskId: task.id,
    provider: task.provider,
    sessionId: task.sessionId,
    status: task.status,
    elapsed: elapsed(task),
  };

  if (task.lastAssistantMessage) {
    base.result = task.lastAssistantMessage;
  }

  if (task.status === "completed" || task.status === "failed") {
    if (task.usage) base.usage = task.usage;
    if (task.costUsd != null) base.costUsd = task.costUsd;
    if (task.numTurns != null) base.numTurns = task.numTurns;
  }

  if (task.status === "failed") {
    base.exitCode = task.exitCode;
    if (task.stderr) base.stderr = task.stderr.slice(-2000);
  }

  return base;
}

function taskStatus(task: Task, tail = 0): Record<string, unknown> {
  const base = taskResult(task);
  base.eventCount = task.events.length;
  if (tail > 0 && task.events.length > 0) {
    base.recentEvents = task.events.slice(-tail);
  }
  return base;
}

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function err(msg: string) {
  return { ...json({ error: msg }), isError: true as const };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const VALID_PROVIDERS = Object.keys(PROVIDERS);

const server = new Server(
  { name: "bro", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "exec",
      description:
        "Launch an agent task. Returns {taskId, sessionId} immediately. " +
        "Use wait to block until the task completes. " +
        `Providers: ${VALID_PROVIDERS.join(", ")}.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Which agent provider to use.",
          },
          prompt: {
            type: "string",
            description: "Task instruction for the agent.",
          },
          project_dir: {
            type: "string",
            description: "Working directory (absolute path).",
          },
        },
        required: ["provider", "prompt"],
      },
    },
    {
      name: "resume",
      description:
        "Resume a previous agent session. Sends a follow-up prompt into the " +
        "same conversation. Returns a new taskId on the same sessionId. " +
        "Use wait to block until the task completes. " +
        "Supported by: claude, codex, vibe, gemini.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "sessionId from a prior exec or wait response.",
          },
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Must match the provider of the original session.",
          },
          prompt: {
            type: "string",
            description: "Follow-up instruction.",
          },
          project_dir: {
            type: "string",
            description: "Working directory (absolute path).",
          },
        },
        required: ["session_id", "provider", "prompt"],
      },
    },
    {
      name: "wait",
      description:
        "Block until a task completes and return its result. " +
        "This call will not return until the agent finishes. " +
        "USE MAXIMUM TIMEOUT. DO NOT CANCEL EARLY. " +
        "If the task is already finished, returns immediately. " +
        "Multiple callers can wait on the same taskId.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "taskId from exec or resume.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "status",
      description:
        "Non-blocking progress check. Returns current state without waiting. " +
        "Use tail to include recent raw events for debugging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "taskId to check.",
          },
          tail: {
            type: "number",
            description: "Number of recent events to include (default 0).",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "providers",
      description: "List configured providers and their binary paths.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "dashboard",
      description:
        "List recent tasks and sessions. Shows task status, provider, " +
        "sessionId, elapsed time, and whether the task has a result. " +
        "Use this to look up a taskId or sessionId you forgot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Filter by provider (optional).",
          },
          status: {
            type: "string",
            enum: ["running", "completed", "failed", "cancelled"],
            description: "Filter by status (optional).",
          },
          limit: {
            type: "number",
            description: "Max entries to return (default 20).",
          },
        },
      },
    },
    {
      name: "cancel",
      description: "Cancel a running task (sends SIGTERM).",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "taskId to cancel.",
          },
        },
        required: ["task_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "exec": {
      const { provider, prompt, project_dir } = args as {
        provider: Provider;
        prompt: string;
        project_dir?: string;
      };
      if (!PROVIDERS[provider]) return err(`Unknown provider: ${provider}`);

      const sessionId = provider === "claude" ? randomUUID() : "pending";
      const execArgs = PROVIDERS[provider].buildExecArgs(prompt, sessionId, project_dir);
      const task = spawnTask(provider, execArgs, sessionId, project_dir);
      return json({ taskId: task.id, sessionId: task.sessionId, status: "running" });
    }

    case "resume": {
      const { session_id, provider, prompt, project_dir } = args as {
        session_id: string;
        provider: Provider;
        prompt: string;
        project_dir?: string;
      };
      if (!PROVIDERS[provider]) return err(`Unknown provider: ${provider}`);
      if (!PROVIDERS[provider].supportsResume) {
        return err(`${provider} does not support session resume`);
      }

      const resumeArgs = PROVIDERS[provider].buildResumeArgs(session_id, prompt);
      const task = spawnTask(provider, resumeArgs, session_id, project_dir);
      return json({ taskId: task.id, sessionId: session_id, status: "running" });
    }

    case "wait": {
      const { task_id } = args as { task_id: string };
      const task = tasks.get(task_id);
      if (!task) return err(`Unknown task ID: ${task_id}`);
      await waitForTask(task);
      return json(taskResult(task));
    }

    case "status": {
      const { task_id, tail = 0 } = args as { task_id: string; tail?: number };
      const task = tasks.get(task_id);
      if (!task) return err(`Unknown task ID: ${task_id}`);
      return json(taskStatus(task, tail));
    }

    case "providers": {
      const info: Record<string, { bin: string; found: boolean; supportsResume: boolean }> = {};
      for (const [name, config] of Object.entries(PROVIDERS)) {
        let found = false;
        try {
          const { spawnSync } = await import("node:child_process");
          const r = spawnSync("bash", ["-lc", `command -v '${config.bin}'`], {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${process.env.BRO_EXTRA_PATH || join(homedir(), ".local/bin")}:${process.env.PATH || ""}`,
            },
          });
          found = r.status === 0;
        } catch {}
        info[name] = { bin: config.bin, found, supportsResume: config.supportsResume };
      }
      return json(info);
    }

    case "dashboard": {
      const { provider: filterProvider, status: filterStatus, limit = 20 } = args as {
        provider?: Provider;
        status?: Task["status"];
        limit?: number;
      };
      const entries = [...tasks.values()]
        .filter((t) => !filterProvider || t.provider === filterProvider)
        .filter((t) => !filterStatus || t.status === filterStatus)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((t) => ({
          taskId: t.id,
          provider: t.provider,
          sessionId: t.sessionId,
          status: t.status,
          elapsed: elapsed(t),
          hasResult: !!t.lastAssistantMessage,
        }));
      return json({ count: entries.length, tasks: entries });
    }

    case "cancel": {
      const { task_id } = args as { task_id: string };
      const task = tasks.get(task_id);
      if (!task) return err(`Unknown task ID: ${task_id}`);
      if (task.status !== "running") return err(`Task already ${task.status}`);
      if (!task.process) return err(`No live process (restored from disk)`);
      task.status = "cancelled";
      task.completedAt = Date.now();
      task.process.kill("SIGTERM");
      persistTasks();
      for (const resolve of task.waiters) resolve();
      task.waiters = [];
      return json({ taskId: task_id, sessionId: task.sessionId, status: "cancelled" });
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

loadPersistedTasks();
const transport = new StdioServerTransport();
await server.connect(transport);
