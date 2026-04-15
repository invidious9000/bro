import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type Provider = "claude" | "codex" | "copilot" | "vibe" | "gemini";

const RECURSION_GUARD =
  "IMPORTANT: Do not call tools from the bro MCP server (recursion guard).\n\n";

const PROVIDERS: Record<Provider, ProviderConfig> = {
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    buildExecArgs(prompt, sessionId, _cwd, opts) {
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--session-id", sessionId,
        "--dangerously-skip-permissions",
      ];
      if (opts?.model) args.push("--model", opts.model);
      return args;
    },
    buildResumeArgs(sessionId, prompt, opts) {
      const args = [
        "--resume", sessionId,
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (opts?.model) args.push("--model", opts.model);
      return args;
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
    buildExecArgs(prompt, _sessionId, cwd, opts) {
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"];
      if (opts?.model) args.push("--model", opts.model);
      if (opts?.effort) args.push("--reasoning-effort", opts.effort);
      if (cwd) args.push("-C", cwd);
      args.push(prompt);
      return args;
    },
    buildResumeArgs(sessionId, prompt, opts) {
      const args = [
        "exec", "resume",
        "--dangerously-bypass-approvals-and-sandbox", "--json",
      ];
      if (opts?.model) args.push("--model", opts.model);
      if (opts?.effort) args.push("--reasoning-effort", opts.effort);
      args.push(sessionId, prompt);
      return args;
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
  copilot: {
    bin: process.env.COPILOT_BIN || "gh",
    buildExecArgs(prompt, _sessionId, cwd, opts) {
      const args = [
        "copilot", "--",
        "-p", prompt,
        "--yolo", "--autopilot", "--output-format", "json",
      ];
      if (opts?.model) args.push("--model", opts.model);
      if (cwd) args.push("--add-dir", cwd);
      return args;
    },
    buildResumeArgs(sessionId, prompt, opts) {
      const args = [
        "copilot", "--",
        "--resume=" + sessionId,
        "-p", prompt,
        "--yolo", "--autopilot", "--output-format", "json",
      ];
      if (opts?.model) args.push("--model", opts.model);
      return args;
    },
    parseEvent(evt, task) {
      // assistant.message — direct text responses
      if (evt.type === "assistant.message") {
        const data = evt.data as Record<string, unknown> | undefined;
        if (data && typeof data.content === "string") {
          task.lastAssistantMessage = data.content;
        }
      }
      // session.task_complete — autopilot mode completion summary
      if (evt.type === "session.task_complete") {
        const data = evt.data as Record<string, unknown> | undefined;
        if (data && typeof data.summary === "string") {
          task.lastAssistantMessage = data.summary;
        }
      }
      // result event has sessionId, usage
      if (evt.type === "result") {
        if (typeof evt.sessionId === "string" && task.sessionId === "pending") {
          task.sessionId = evt.sessionId as string;
        }
        const usage = evt.usage as Record<string, unknown> | undefined;
        if (usage) {
          task.usage = {
            input_tokens: 0,
            output_tokens: 0,
          };
          task.numTurns = (usage.premiumRequests as number) ?? undefined;
        }
      }
    },
    extractSessionId(evt, task) {
      if (evt.type === "result" && typeof evt.sessionId === "string") {
        task.sessionId = evt.sessionId as string;
      }
    },
    supportsResume: true,
  },
  vibe: {
    bin: process.env.VIBE_BIN || "vibe",
    buildExecArgs(prompt, _sessionId, _cwd, opts) {
      const args = ["-p", prompt, "--output", "json"];
      if (opts?.model) args.push("--model", opts.model);
      return args;
    },
    buildResumeArgs(sessionId, prompt, opts) {
      const args = [
        "--resume", sessionId,
        "-p", prompt, "--output", "json",
      ];
      if (opts?.model) args.push("--model", opts.model);
      return args;
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
    buildExecArgs(prompt, _sessionId, _cwd, opts) {
      const args = ["-p", prompt, "--yolo", "-o", "json"];
      if (opts?.model) args.push("--model", opts.model);
      return args;
    },
    buildResumeArgs(sessionId, prompt, opts) {
      const args = [
        "--resume", sessionId,
        "-p", prompt, "--yolo", "-o", "json",
      ];
      if (opts?.model) args.push("--model", opts.model);
      return args;
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

interface BroExecOpts {
  model?: string;
  effort?: string;
}

interface ProviderConfig {
  bin: string;
  buildExecArgs(prompt: string, sessionId: string, cwd?: string, opts?: BroExecOpts): string[];
  buildResumeArgs(sessionId: string, prompt: string, opts?: BroExecOpts): string[];
  parseEvent(evt: Record<string, unknown>, task: Task): void;
  extractSessionId(evt: Record<string, unknown>, task: Task): void;
  supportsResume: boolean;
}

// ---------------------------------------------------------------------------
// Brofile / Teamplate / Team types
// ---------------------------------------------------------------------------

interface Account {
  env?: Record<string, string>;
}

interface Brofile {
  name: string;
  provider: Provider;
  account?: string;
  lens?: string;
  model?: string;
  effort?: string;
}

interface TeamplateMember {
  brofile: string;
  alias?: string;
  count?: number;
}

interface Teamplate {
  name: string;
  members: TeamplateMember[];
}

interface BroInstance {
  name: string;
  brofile: string;
  sessionId?: string;
  taskHistory: string[];
}

interface Team {
  name: string;
  teamplate: string;
  members: BroInstance[];
  createdAt: number;
  projectDir?: string;
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
// Brofile / Teamplate / Team persistence
// ---------------------------------------------------------------------------

const BROFILES_DIR = join(STORE_DIR, "brofiles");
const TEAMPLATES_DIR = join(STORE_DIR, "teamplates");
const TEAMS_DIR = join(STORE_DIR, "teams");
const CONFIG_FILE = join(STORE_DIR, "config.json");

interface BroConfig {
  accounts?: Record<string, Account>;
}

function loadConfig(): BroConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as BroConfig;
  } catch { return {}; }
}

function saveConfig(config: BroConfig): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, CONFIG_FILE);
}

function loadAccount(name: string): Account | null {
  return loadConfig().accounts?.[name] ?? null;
}

function resolveBrofile(name: string, projectDir?: string): Brofile | null {
  if (projectDir) {
    const local = join(projectDir, ".bro", "brofiles", `${name}.json`);
    try { return JSON.parse(readFileSync(local, "utf-8")) as Brofile; } catch {}
  }
  const global = join(BROFILES_DIR, `${name}.json`);
  try { return JSON.parse(readFileSync(global, "utf-8")) as Brofile; } catch {}
  return null;
}

function saveBrofile(brofile: Brofile, scope: "global" | "project", projectDir?: string): void {
  const dir = scope === "project" && projectDir
    ? join(projectDir, ".bro", "brofiles") : BROFILES_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${brofile.name}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(brofile, null, 2));
  renameSync(tmp, file);
}

function deleteBrofile(name: string, scope: "global" | "project", projectDir?: string): boolean {
  const dir = scope === "project" && projectDir
    ? join(projectDir, ".bro", "brofiles") : BROFILES_DIR;
  try { unlinkSync(join(dir, `${name}.json`)); return true; } catch { return false; }
}

function listBrofiles(scope?: "global" | "project", projectDir?: string): Brofile[] {
  const results: Brofile[] = [];
  const seen = new Set<string>();
  const dirs: Array<{ path: string; scope: string }> = [];
  // Project-local first (wins on collision)
  if ((!scope || scope === "project") && projectDir)
    dirs.push({ path: join(projectDir, ".bro", "brofiles"), scope: "project" });
  if (!scope || scope === "global")
    dirs.push({ path: BROFILES_DIR, scope: "global" });
  for (const { path: dir, scope: s } of dirs) {
    try {
      for (const f of readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
        try {
          const bf = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Brofile;
          if (!seen.has(bf.name)) {
            seen.add(bf.name);
            results.push({ ...bf, ...(s === "project" ? { _scope: "project" } : {}) } as Brofile);
          }
        } catch {}
      }
    } catch {}
  }
  return results;
}

function resolveTeamplate(name: string, projectDir?: string): Teamplate | null {
  if (projectDir) {
    const local = join(projectDir, ".bro", "teamplates", `${name}.json`);
    try { return JSON.parse(readFileSync(local, "utf-8")) as Teamplate; } catch {}
  }
  const global = join(TEAMPLATES_DIR, `${name}.json`);
  try { return JSON.parse(readFileSync(global, "utf-8")) as Teamplate; } catch {}
  return null;
}

function saveTeamplate(tp: Teamplate, scope: "global" | "project", projectDir?: string): void {
  const dir = scope === "project" && projectDir
    ? join(projectDir, ".bro", "teamplates") : TEAMPLATES_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tp.name}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(tp, null, 2));
  renameSync(tmp, file);
}

function deleteTeamplate(name: string, scope: "global" | "project", projectDir?: string): boolean {
  const dir = scope === "project" && projectDir
    ? join(projectDir, ".bro", "teamplates") : TEAMPLATES_DIR;
  try { unlinkSync(join(dir, `${name}.json`)); return true; } catch { return false; }
}

function listTeamplates(scope?: "global" | "project", projectDir?: string): Teamplate[] {
  const results: Teamplate[] = [];
  const seen = new Set<string>();
  const dirs: Array<{ path: string; scope: string }> = [];
  if ((!scope || scope === "project") && projectDir)
    dirs.push({ path: join(projectDir, ".bro", "teamplates"), scope: "project" });
  if (!scope || scope === "global")
    dirs.push({ path: TEAMPLATES_DIR, scope: "global" });
  for (const { path: dir } of dirs) {
    try {
      for (const f of readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
        try {
          const tp = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Teamplate;
          if (!seen.has(tp.name)) { seen.add(tp.name); results.push(tp); }
        } catch {}
      }
    } catch {}
  }
  return results;
}

function loadTeam(name: string): Team | null {
  try { return JSON.parse(readFileSync(join(TEAMS_DIR, `${name}.json`), "utf-8")) as Team; }
  catch { return null; }
}

function saveTeam(team: Team): void {
  mkdirSync(TEAMS_DIR, { recursive: true });
  const file = join(TEAMS_DIR, `${team.name}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(team, null, 2));
  renameSync(tmp, file);
}

function removeTeam(name: string): boolean {
  try { unlinkSync(join(TEAMS_DIR, `${name}.json`)); return true; } catch { return false; }
}

function loadAllTeams(): Team[] {
  try {
    return readdirSync(TEAMS_DIR)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => JSON.parse(readFileSync(join(TEAMS_DIR, f), "utf-8")) as Team);
  } catch { return []; }
}

function findBroInstance(broName: string): { team: Team; member: BroInstance } | null {
  const matches: { team: Team; member: BroInstance }[] = [];
  for (const team of loadAllTeams()) {
    const member = team.members.find(m => m.name === broName);
    if (member) matches.push({ team, member });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1)
    throw new Error(
      `Ambiguous bro "${broName}" — exists in teams: ${matches.map(m => m.team.name).join(", ")}. Use team/member syntax.`,
    );
  return matches[0];
}

function instantiateTeam(
  teamplate: Teamplate, teamName: string, projectDir?: string,
): Team {
  const members: BroInstance[] = [];
  for (const slot of teamplate.members) {
    const count = slot.count ?? 1;
    const baseName = slot.alias ?? slot.brofile;
    for (let i = 0; i < count; i++) {
      members.push({
        name: count > 1 ? `${baseName}-${i + 1}` : baseName,
        brofile: slot.brofile,
        taskHistory: [],
      });
    }
  }
  const team: Team = {
    name: teamName,
    teamplate: teamplate.name,
    members,
    createdAt: Date.now(),
    projectDir,
  };
  saveTeam(team);
  return team;
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
  let entries: string[];
  try {
    entries = readdirSync(VIBE_SESSION_DIR);
  } catch {
    return null;
  }

  let resolvedProjectDir: string;
  try { resolvedProjectDir = realpathSync(projectDir); }
  catch { resolvedProjectDir = projectDir; }

  // Vibe stores sessions as directories: session_YYYYMMDD_HHMMSS_<shortid>/meta.json
  const metaFiles = entries
    .filter((n) => n.startsWith("session_"))
    .map((n) => join(VIBE_SESSION_DIR, n, "meta.json"))
    .filter((f) => { try { statSync(f); return true; } catch { return false; } });

  const scored = metaFiles
    .map((file) => {
      try {
        const st = statSync(file);
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const env = (data.environment || {}) as Record<string, unknown>;
        const wd = env.working_directory as string | undefined;
        let matchesDir = false;
        if (wd) {
          try { matchesDir = realpathSync(wd) === resolvedProjectDir; }
          catch { matchesDir = wd === projectDir; }
        }
        const recent = st.mtimeMs >= startMs - 2000;
        const sessionId = data.session_id as string | undefined;
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

function applyLens(
  prompt: string,
  lens?: string,
  allowRecursion?: boolean,
): string {
  let result = allowRecursion ? prompt : RECURSION_GUARD + prompt;
  if (lens) result = `${lens}\n\n${result}`;
  return result;
}

function spawnTask(
  provider: Provider,
  args: string[],
  sessionId: string,
  cwd?: string,
  envOverrides?: Record<string, string>,
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
    ...envOverrides,
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

  const isStreamingJson = provider === "claude" || provider === "codex" || provider === "copilot";
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

function findBroNameForTask(taskId: string): string | null {
  for (const team of loadAllTeams()) {
    for (const member of team.members) {
      if (member.taskHistory.includes(taskId)) return member.name;
    }
  }
  return null;
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

function setupHandlers(srv: Server): void {

srv.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "exec",
      description:
        "Launch an agent task. Returns {taskId, sessionId, bro?} immediately — " +
        "the agent runs in the background. Prefer targeting a named bro " +
        "(resolves provider, account, and lens automatically) over raw provider. " +
        "Use raw provider only for ad-hoc one-off tasks. " +
        `Providers: ${VALID_PROVIDERS.join(", ")}.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          bro: {
            type: "string",
            description:
              "Named bro instance to target. Resolves provider, account, " +
              "and lens from its brofile. Mutually exclusive with provider.",
          },
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description:
              "Raw provider for ad-hoc tasks. Use bro param instead when " +
              "targeting a named bro instance.",
          },
          prompt: {
            type: "string",
            description: "Task instruction for the agent.",
          },
          project_dir: {
            type: "string",
            description: "Working directory (absolute path). Defaults to bro's team projectDir if targeting a named bro.",
          },
          allow_recursion: {
            type: "boolean",
            description:
              "Skip the anti-recursion guard, allowing the spawned agent to " +
              "call bro MCP tools. Default: false.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "resume",
      description:
        "Resume a previous agent session with a follow-up prompt. " +
        "Prefer targeting a named bro (sessionId looked up automatically) " +
        "over raw session_id + provider. Returns a new taskId on the same session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          bro: {
            type: "string",
            description:
              "Named bro instance to resume. SessionId and provider resolved " +
              "automatically. Mutually exclusive with session_id + provider.",
          },
          session_id: {
            type: "string",
            description: "sessionId from a prior exec or wait response. Requires provider.",
          },
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Must match the provider of the original session. Required with session_id.",
          },
          prompt: {
            type: "string",
            description: "Follow-up instruction.",
          },
          project_dir: {
            type: "string",
            description: "Working directory (absolute path).",
          },
          allow_recursion: {
            type: "boolean",
            description:
              "Skip the anti-recursion guard. Default: false.",
          },
        },
        required: ["prompt"],
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
        "bro name, sessionId, elapsed time, and whether the task has a result. " +
        "Use this to look up a taskId or sessionId you forgot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Filter by provider (optional).",
          },
          team: {
            type: "string",
            description: "Filter to tasks from a specific team (optional).",
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
    {
      name: "broadcast",
      description:
        "Send the same prompt to every member of a team. Resumes existing " +
        "sessions automatically; starts fresh for members with no session. " +
        "Returns an array of {bro, taskId}. Follow up with when_all or when_any.",
      inputSchema: {
        type: "object" as const,
        properties: {
          team: {
            type: "string",
            description: "Team name to broadcast to.",
          },
          prompt: {
            type: "string",
            description: "Prompt sent to every team member.",
          },
          project_dir: {
            type: "string",
            description: "Working directory override (defaults to team's projectDir).",
          },
          allow_recursion: {
            type: "boolean",
            description: "Skip the anti-recursion guard. Default: false.",
          },
        },
        required: ["team", "prompt"],
      },
    },
    {
      name: "when_all",
      description:
        "Block until ALL tasks complete. Accepts a team name (waits on each " +
        "member's latest task) or an array of task IDs. Returns collected " +
        "results for every task. USE MAXIMUM TIMEOUT. " +
        "Use after broadcast for blind deliberation or provider comparison.",
      inputSchema: {
        type: "object" as const,
        properties: {
          team: {
            type: "string",
            description: "Team name — waits on each member's most recent task.",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Explicit list of taskIds to await. Alternative to team.",
          },
        },
      },
    },
    {
      name: "when_any",
      description:
        "Block until the FIRST task completes. Accepts a team name or an " +
        "array of task IDs. Returns all current states — the winner shows " +
        "completed, others may still be running. USE MAXIMUM TIMEOUT. " +
        "Use for racing providers or fast-path resolution.",
      inputSchema: {
        type: "object" as const,
        properties: {
          team: {
            type: "string",
            description: "Team name — races each member's most recent task.",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Explicit list of taskIds to race. Alternative to team.",
          },
        },
      },
    },
    {
      name: "brofile",
      description:
        "Manage brofile templates and accounts. Brofiles define reusable agent " +
        "configurations: provider + account + lens (personality/system prompt). " +
        "Create brofiles before instantiating teams that reference them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "get", "delete", "set_account", "list_accounts"],
            description: "Operation to perform.",
          },
          name: {
            type: "string",
            description: "Brofile or account name (required for create/get/delete/set_account).",
          },
          provider: {
            type: "string",
            enum: VALID_PROVIDERS,
            description: "Agent provider (required for create).",
          },
          account: {
            type: "string",
            description: "Account name to use (optional, for create). References accounts registry.",
          },
          lens: {
            type: "string",
            description: "System prompt / personality override (optional, for create).",
          },
          model: {
            type: "string",
            description: "Model override (optional, for create). Passed as --model to the provider CLI.",
          },
          effort: {
            type: "string",
            description: "Reasoning effort level (optional, for create). E.g. 'low', 'medium', 'high'. Provider-specific.",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Environment variable overrides (for set_account).",
          },
          scope: {
            type: "string",
            enum: ["global", "project"],
            description: "Where to store/search (default: global). Project scope requires project_dir.",
          },
          project_dir: {
            type: "string",
            description: "Project directory for project-scoped operations.",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "team",
      description:
        "Manage teamplates (ensemble blueprints) and team instances. " +
        "Create a teamplate first, then instantiate it to get a named team " +
        "you can broadcast to.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: [
              "save_template", "list_templates", "delete_template",
              "create", "list", "dissolve", "roster",
            ],
            description: "Operation to perform.",
          },
          name: {
            type: "string",
            description: "Teamplate or team name.",
          },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: {
                brofile: { type: "string", description: "Brofile name." },
                alias: { type: "string", description: "Custom name for this slot." },
                count: { type: "number", description: "Number of instances (default 1)." },
              },
              required: ["brofile"],
            },
            description: "Member slots (for save_template).",
          },
          template: {
            type: "string",
            description: "Teamplate to instantiate (for create).",
          },
          project_dir: {
            type: "string",
            description: "Working directory for the team (for create) or template scope.",
          },
          scope: {
            type: "string",
            enum: ["global", "project"],
            description: "Where to store/search templates (default: global).",
          },
          cancel_running: {
            type: "boolean",
            description: "Cancel running tasks when dissolving (default: false).",
          },
        },
        required: ["action"],
      },
    },
  ],
}));

srv.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "exec": {
      const { bro: broName, provider: rawProvider, prompt, project_dir, allow_recursion } = args as {
        bro?: string;
        provider?: Provider;
        prompt: string;
        project_dir?: string;
        allow_recursion?: boolean;
      };

      let provider: Provider;
      let lens: string | undefined;
      let envOverrides: Record<string, string> | undefined;
      let execOpts: BroExecOpts | undefined;
      let cwd = project_dir;
      let broMatch: { team: Team; member: BroInstance } | null = null;

      if (broName) {
        try { broMatch = findBroInstance(broName); } catch (e: unknown) {
          return err((e as Error).message);
        }
        if (!broMatch) return err(`Unknown bro: ${broName}`);
        const brofile = resolveBrofile(broMatch.member.brofile, broMatch.team.projectDir);
        if (!brofile) return err(`Brofile not found: ${broMatch.member.brofile}`);
        provider = brofile.provider;
        lens = brofile.lens;
        if (brofile.model || brofile.effort) execOpts = { model: brofile.model, effort: brofile.effort };
        if (brofile.account) {
          const acct = loadAccount(brofile.account);
          if (acct?.env) envOverrides = acct.env;
        }
        if (!cwd) cwd = broMatch.team.projectDir;
      } else if (rawProvider) {
        provider = rawProvider;
      } else {
        return err("Provide either bro or provider");
      }

      if (!PROVIDERS[provider]) return err(`Unknown provider: ${provider}`);

      const finalPrompt = applyLens(prompt, lens, allow_recursion);
      const sessionId = provider === "claude" ? randomUUID() : "pending";
      const execArgs = PROVIDERS[provider].buildExecArgs(finalPrompt, sessionId, cwd, execOpts);
      const task = spawnTask(provider, execArgs, sessionId, cwd, envOverrides);

      if (broMatch) {
        broMatch.member.taskHistory.push(task.id);
        if (!broMatch.member.sessionId || broMatch.member.sessionId === "pending") {
          broMatch.member.sessionId = task.sessionId;
        }
        saveTeam(broMatch.team);
      }

      const result: Record<string, unknown> = { taskId: task.id, sessionId: task.sessionId, status: "running" };
      if (broName) result.bro = broName;
      return json(result);
    }

    case "resume": {
      const { bro: broName, session_id, provider: rawProvider, prompt, project_dir, allow_recursion } = args as {
        bro?: string;
        session_id?: string;
        provider?: Provider;
        prompt: string;
        project_dir?: string;
        allow_recursion?: boolean;
      };

      let provider: Provider;
      let sessionId: string;
      let lens: string | undefined;
      let envOverrides: Record<string, string> | undefined;
      let execOpts: BroExecOpts | undefined;
      let cwd = project_dir;
      let broMatch: { team: Team; member: BroInstance } | null = null;

      if (broName) {
        try { broMatch = findBroInstance(broName); } catch (e: unknown) {
          return err((e as Error).message);
        }
        if (!broMatch) return err(`Unknown bro: ${broName}`);
        if (!broMatch.member.sessionId || broMatch.member.sessionId === "pending") {
          return err(`Bro "${broName}" has no active session — use exec first`);
        }
        const brofile = resolveBrofile(broMatch.member.brofile, broMatch.team.projectDir);
        if (!brofile) return err(`Brofile not found: ${broMatch.member.brofile}`);
        provider = brofile.provider;
        sessionId = broMatch.member.sessionId;
        lens = brofile.lens;
        if (brofile.model || brofile.effort) execOpts = { model: brofile.model, effort: brofile.effort };
        if (brofile.account) {
          const acct = loadAccount(brofile.account);
          if (acct?.env) envOverrides = acct.env;
        }
        if (!cwd) cwd = broMatch.team.projectDir;
      } else if (session_id && rawProvider) {
        provider = rawProvider;
        sessionId = session_id;
      } else {
        return err("Provide either bro, or session_id + provider");
      }

      if (!PROVIDERS[provider]) return err(`Unknown provider: ${provider}`);
      if (!PROVIDERS[provider].supportsResume) {
        return err(`${provider} does not support session resume`);
      }

      const finalPrompt = applyLens(prompt, lens, allow_recursion);
      const resumeArgs = PROVIDERS[provider].buildResumeArgs(sessionId, finalPrompt, execOpts);
      const task = spawnTask(provider, resumeArgs, sessionId, cwd, envOverrides);

      if (broMatch) {
        broMatch.member.taskHistory.push(task.id);
        saveTeam(broMatch.team);
      }

      const result: Record<string, unknown> = { taskId: task.id, sessionId, status: "running" };
      if (broName) result.bro = broName;
      return json(result);
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
      const { provider: filterProvider, team: filterTeam, status: filterStatus, limit = 20 } = args as {
        provider?: Provider;
        team?: string;
        status?: Task["status"];
        limit?: number;
      };

      // Build set of taskIds belonging to the filtered team
      let teamTaskIds: Set<string> | null = null;
      if (filterTeam) {
        const team = loadTeam(filterTeam);
        if (!team) return err(`Unknown team: ${filterTeam}`);
        teamTaskIds = new Set(team.members.flatMap(m => m.taskHistory));
      }

      const entries = [...tasks.values()]
        .filter((t) => !filterProvider || t.provider === filterProvider)
        .filter((t) => !filterStatus || t.status === filterStatus)
        .filter((t) => !teamTaskIds || teamTaskIds.has(t.id))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((t) => {
          const broName = findBroNameForTask(t.id);
          return {
            taskId: t.id,
            provider: t.provider,
            ...(broName ? { bro: broName } : {}),
            sessionId: t.sessionId,
            status: t.status,
            elapsed: elapsed(t),
            hasResult: !!t.lastAssistantMessage,
          };
        });
      return json({ count: entries.length, tasks: entries });
    }

    case "broadcast": {
      const { team: teamName, prompt, project_dir, allow_recursion } = args as {
        team: string;
        prompt: string;
        project_dir?: string;
        allow_recursion?: boolean;
      };
      const team = loadTeam(teamName);
      if (!team) return err(`Unknown team: ${teamName}`);

      const cwd = project_dir ?? team.projectDir;
      const launched: Array<Record<string, unknown>> = [];

      for (const member of team.members) {
        const brofile = resolveBrofile(member.brofile, team.projectDir);
        if (!brofile) {
          launched.push({ bro: member.name, error: `Brofile not found: ${member.brofile}` });
          continue;
        }
        if (!PROVIDERS[brofile.provider]) {
          launched.push({ bro: member.name, error: `Unknown provider: ${brofile.provider}` });
          continue;
        }

        const finalPrompt = applyLens(prompt, brofile.lens, allow_recursion);
        let envOverrides: Record<string, string> | undefined;
        if (brofile.account) {
          const acct = loadAccount(brofile.account);
          if (acct?.env) envOverrides = acct.env;
        }
        const opts: BroExecOpts | undefined =
          (brofile.model || brofile.effort) ? { model: brofile.model, effort: brofile.effort } : undefined;

        let task: Task;
        if (member.sessionId && member.sessionId !== "pending") {
          // Resume existing session
          const resumeArgs = PROVIDERS[brofile.provider].buildResumeArgs(member.sessionId, finalPrompt, opts);
          task = spawnTask(brofile.provider, resumeArgs, member.sessionId, cwd, envOverrides);
        } else {
          // Fresh exec
          const sessionId = brofile.provider === "claude" ? randomUUID() : "pending";
          const execArgs = PROVIDERS[brofile.provider].buildExecArgs(finalPrompt, sessionId, cwd, opts);
          task = spawnTask(brofile.provider, execArgs, sessionId, cwd, envOverrides);
          if (!member.sessionId) member.sessionId = task.sessionId;
        }

        member.taskHistory.push(task.id);
        launched.push({ bro: member.name, taskId: task.id, sessionId: task.sessionId });
      }

      saveTeam(team);
      return json({ team: teamName, tasks: launched });
    }

    case "when_all": {
      const { team: teamName, task_ids: rawIds } = args as {
        team?: string;
        task_ids?: string[];
      };

      let taskIds: string[];
      if (teamName) {
        const team = loadTeam(teamName);
        if (!team) return err(`Unknown team: ${teamName}`);
        taskIds = team.members
          .map(m => m.taskHistory[m.taskHistory.length - 1])
          .filter(Boolean);
        if (taskIds.length === 0) return err(`No tasks found for team ${teamName}`);
      } else if (rawIds && rawIds.length > 0) {
        taskIds = rawIds;
      } else {
        return err("Provide either team or task_ids");
      }

      await Promise.all(taskIds.map(id => {
        const t = tasks.get(id);
        return t ? waitForTask(t) : Promise.resolve();
      }));

      const results = taskIds.map(id => {
        const t = tasks.get(id);
        if (!t) return { taskId: id, error: "not found" };
        // Find bro name for this task
        const broName = findBroNameForTask(id);
        const r = taskResult(t);
        if (broName) r.bro = broName;
        return r;
      });
      return json({ results });
    }

    case "when_any": {
      const { team: teamName, task_ids: rawIds } = args as {
        team?: string;
        task_ids?: string[];
      };

      let taskIds: string[];
      if (teamName) {
        const team = loadTeam(teamName);
        if (!team) return err(`Unknown team: ${teamName}`);
        taskIds = team.members
          .map(m => m.taskHistory[m.taskHistory.length - 1])
          .filter(Boolean);
        if (taskIds.length === 0) return err(`No tasks found for team ${teamName}`);
      } else if (rawIds && rawIds.length > 0) {
        taskIds = rawIds;
      } else {
        return err("Provide either team or task_ids");
      }

      // If any task is already done, return immediately; otherwise race
      const running = taskIds.filter(id => {
        const t = tasks.get(id);
        return t && t.status === "running";
      });
      if (running.length > 0) {
        await Promise.race(running.map(id => waitForTask(tasks.get(id)!)));
      }

      const results = taskIds.map(id => {
        const t = tasks.get(id);
        if (!t) return { taskId: id, error: "not found" };
        const broName = findBroNameForTask(id);
        const r = taskResult(t);
        if (broName) r.bro = broName;
        return r;
      });
      return json({ results });
    }

    case "brofile": {
      const { action, name: bfName, provider: bfProvider, account: bfAccount,
              lens: bfLens, model: bfModel, effort: bfEffort, env: bfEnv,
              scope = "global", project_dir } = args as {
        action: string;
        name?: string;
        provider?: Provider;
        account?: string;
        lens?: string;
        model?: string;
        effort?: string;
        env?: Record<string, string>;
        scope?: "global" | "project";
        project_dir?: string;
      };

      switch (action) {
        case "create": {
          if (!bfName) return err("name is required");
          if (!bfProvider) return err("provider is required");
          if (!PROVIDERS[bfProvider]) return err(`Unknown provider: ${bfProvider}`);
          if (scope === "project" && !project_dir) return err("project_dir required for project scope");
          const bf: Brofile = {
            name: bfName, provider: bfProvider,
            ...(bfAccount ? { account: bfAccount } : {}),
            ...(bfLens ? { lens: bfLens } : {}),
            ...(bfModel ? { model: bfModel } : {}),
            ...(bfEffort ? { effort: bfEffort } : {}),
          };
          saveBrofile(bf, scope, project_dir);
          return json({ created: bfName, scope, brofile: bf });
        }
        case "list":
          return json(listBrofiles(scope, project_dir));
        case "get": {
          if (!bfName) return err("name is required");
          const bf = resolveBrofile(bfName, project_dir);
          if (!bf) return err(`Brofile not found: ${bfName}`);
          return json(bf);
        }
        case "delete": {
          if (!bfName) return err("name is required");
          if (scope === "project" && !project_dir) return err("project_dir required for project scope");
          const ok = deleteBrofile(bfName, scope, project_dir);
          return ok ? json({ deleted: bfName }) : err(`Brofile not found: ${bfName}`);
        }
        case "set_account": {
          if (!bfName) return err("name is required");
          const config = loadConfig();
          if (!config.accounts) config.accounts = {};
          config.accounts[bfName] = { env: bfEnv };
          saveConfig(config);
          return json({ account: bfName, env: bfEnv });
        }
        case "list_accounts":
          return json(loadConfig().accounts ?? {});
        default:
          return err(`Unknown brofile action: ${action}`);
      }
    }

    case "team": {
      const { action, name: tmName, members: tmMembers, template: tmTemplate,
              project_dir, scope = "global", cancel_running } = args as {
        action: string;
        name?: string;
        members?: TeamplateMember[];
        template?: string;
        project_dir?: string;
        scope?: "global" | "project";
        cancel_running?: boolean;
      };

      switch (action) {
        case "save_template": {
          if (!tmName) return err("name is required");
          if (!tmMembers || tmMembers.length === 0) return err("members is required");
          if (scope === "project" && !project_dir) return err("project_dir required for project scope");
          // Validate brofile names
          for (const m of tmMembers) {
            const bf = resolveBrofile(m.brofile, project_dir);
            if (!bf) return err(`Brofile not found: ${m.brofile}`);
          }
          const tp: Teamplate = { name: tmName, members: tmMembers };
          saveTeamplate(tp, scope, project_dir);
          return json({ saved: tmName, scope, teamplate: tp });
        }
        case "list_templates":
          return json(listTeamplates(scope, project_dir));
        case "delete_template": {
          if (!tmName) return err("name is required");
          if (scope === "project" && !project_dir) return err("project_dir required for project scope");
          const ok = deleteTeamplate(tmName, scope, project_dir);
          return ok ? json({ deleted: tmName }) : err(`Teamplate not found: ${tmName}`);
        }
        case "create": {
          if (!tmTemplate) return err("template is required");
          const tp = resolveTeamplate(tmTemplate, project_dir);
          if (!tp) return err(`Teamplate not found: ${tmTemplate}`);
          const teamName = tmName ?? `${tmTemplate}-${Date.now()}`;
          // Validate all brofiles exist before instantiating
          for (const m of tp.members) {
            const bf = resolveBrofile(m.brofile, project_dir);
            if (!bf) return err(`Brofile not found: ${m.brofile}`);
          }
          const team = instantiateTeam(tp, teamName, project_dir);
          return json({
            created: team.name,
            teamplate: tp.name,
            members: team.members.map(m => ({ name: m.name, brofile: m.brofile })),
          });
        }
        case "list":
          return json(loadAllTeams().map(t => ({
            name: t.name, teamplate: t.teamplate,
            memberCount: t.members.length, createdAt: t.createdAt,
            projectDir: t.projectDir,
          })));
        case "dissolve": {
          if (!tmName) return err("name is required");
          const team = loadTeam(tmName);
          if (!team) return err(`Unknown team: ${tmName}`);
          if (cancel_running) {
            for (const member of team.members) {
              for (const tid of member.taskHistory) {
                const t = tasks.get(tid);
                if (t && t.status === "running" && t.process) {
                  t.status = "cancelled";
                  t.completedAt = Date.now();
                  t.process.kill("SIGTERM");
                  for (const resolve of t.waiters) resolve();
                  t.waiters = [];
                }
              }
            }
            persistTasks();
          }
          removeTeam(tmName);
          return json({ dissolved: tmName });
        }
        case "roster": {
          if (!tmName) return err("name is required");
          const team = loadTeam(tmName);
          if (!team) return err(`Unknown team: ${tmName}`);
          const roster = team.members.map(m => {
            const latestTaskId = m.taskHistory[m.taskHistory.length - 1];
            const latestTask = latestTaskId ? tasks.get(latestTaskId) : undefined;
            return {
              name: m.name,
              brofile: m.brofile,
              sessionId: m.sessionId ?? null,
              taskCount: m.taskHistory.length,
              latestTask: latestTask ? {
                taskId: latestTaskId,
                status: latestTask.status,
                elapsed: elapsed(latestTask),
              } : null,
            };
          });
          return json({ team: tmName, teamplate: team.teamplate, members: roster });
        }
        default:
          return err(`Unknown team action: ${action}`);
      }
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

} // setupHandlers

// ---------------------------------------------------------------------------
// Start — HTTP daemon
// ---------------------------------------------------------------------------

const BRO_PORT = Number(process.env.BRO_PORT) || 7263;
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

loadPersistedTasks();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${BRO_PORT}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      await session.transport.handleRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown session" }));
    }
    return;
  }

  // New MCP session
  const sessionServer = new Server(
    { name: "bro", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  setupHandlers(sessionServer);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => { sessions.set(id, { transport, server: sessionServer }); },
    onsessionclosed: (id: string) => { sessions.delete(id); },
  });
  await sessionServer.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(BRO_PORT, "127.0.0.1", () => {
  console.error(`bro daemon listening on http://127.0.0.1:${BRO_PORT}/mcp`);
});
