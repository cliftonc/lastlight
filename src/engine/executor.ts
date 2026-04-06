import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { AgentDefinition } from "./agents.js";
import { createTaskSandbox, sandboxAvailable, type DockerSandbox } from "../sandbox/index.js";
import { refreshGitAuth } from "./git-auth.js";

/** Default directory for agent context files (soul, rules, etc.) */
const AGENT_CONTEXT_DIR = resolve("agent-context");

/**
 * Configuration for the Agent SDK executor.
 */
export interface ExecutorConfig {
  /** Path to the MCP server config for GitHub tools */
  mcpConfigPath: string;
  /** Working directory for the agent */
  cwd?: string;
  /** Maximum conversation turns */
  maxTurns?: number;
  /** Model to use */
  model?: string;
  /** Path to agent context directory (soul.md, rules.md, etc.) */
  agentContextDir?: string;
  /** Directory for persistent state (sessions, logs). Mounted as Docker volume. */
  stateDir?: string;
  /** Directory for agent sandboxes (cloned repos). */
  sandboxDir?: string;
}

/**
 * Result from an agent execution.
 */
export interface ExecutionResult {
  success: boolean;
  output: string;
  turns: number;
  error?: string;
  durationMs: number;
}

/**
 * Load all .md files from the agent-context directory and concatenate
 * them into a single system prompt string.
 */
function loadAgentContext(dir?: string): string {
  const contextDir = dir || AGENT_CONTEXT_DIR;
  try {
    const files = readdirSync(contextDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    return files
      .map((f) => readFileSync(join(contextDir, f), "utf-8"))
      .join("\n\n---\n\n");
  } catch {
    console.warn(`[executor] No agent context found at ${contextDir}`);
    return "";
  }
}

/**
 * Execute an agent task.
 *
 * Execution modes (automatic):
 * 1. Docker sandbox — if Docker + sandbox image available, runs `claude --print`
 *    inside an isolated container. Full sandboxing.
 * 2. Direct — runs Agent SDK query() in-process. Local dev fallback.
 */
export async function executeAgent(
  prompt: string,
  config: ExecutorConfig,
  opts?: { taskId?: string }
): Promise<ExecutionResult> {
  const taskId = opts?.taskId || `task-${randomUUID().slice(0, 8)}`;
  const stateDir = config.stateDir || resolve("data");

  // Generate a fresh GitHub App token for the sandbox so git works immediately
  const env: Record<string, string> = {};
  if (process.env.GITHUB_APP_ID) {
    env.GITHUB_APP_ID = process.env.GITHUB_APP_ID;
    env.GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
    try {
      const { token } = await refreshGitAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
      });
      env.GIT_TOKEN = token;
    } catch (err: any) {
      console.warn(`[executor] Could not generate git token: ${err.message}`);
    }
  }

  // Try Docker sandbox first
  const sbx = await createTaskSandbox({
    taskId,
    stateDir,
    sandboxDir: config.sandboxDir,
    env,
  });

  if (sbx) {
    return executeSandboxed(prompt, config, sbx.sandbox, taskId, sbx.cleanup);
  }

  // Direct execution only if explicitly enabled — sandboxing is the default
  if (process.env.ENABLE_DIRECT_FALLBACK === "true") {
    console.warn(`  [executor] No sandbox available — falling back to direct execution`);
    return executeDirect(prompt, config);
  }

  throw new Error("Docker sandbox not available and ENABLE_DIRECT_FALLBACK is not enabled. Install Docker and build the sandbox image (docker-compose build sandbox), or set ENABLE_DIRECT_FALLBACK=true.");
}

/**
 * Execute a skill by name.
 */
export async function executeSkill(
  skill: string,
  context: Record<string, unknown>,
  config: ExecutorConfig,
  agents?: Record<string, AgentDefinition>
): Promise<ExecutionResult> {
  const contextLines = Object.entries(context)
    .filter(([k, v]) => v !== undefined && v !== null && k !== "_triggerType")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

  // Load the skill content and inject it directly into the prompt.
  // Claude Code's slash command discovery doesn't work reliably in headless -p mode,
  // so we include the skill instructions in the prompt itself.
  let skillContent = "";
  for (const base of [resolve("skills"), resolve(".claude/skills")]) {
    try {
      skillContent = readFileSync(join(base, skill, "SKILL.md"), "utf-8");
      break;
    } catch { /* try next path */ }
  }

  const prompt = skillContent
    ? `Follow these skill instructions:\n\n${skillContent}\n\nContext:\n${contextLines}`
    : `Perform "${skill}" with this context:\n\n${contextLines}`;

  console.log(`[executor] Running skill: ${skill}`);

  const taskId = `${skill}-${randomUUID().slice(0, 8)}`;
  return executeAgent(prompt, config, { taskId });
}

// ── Docker sandbox execution ────────────────────────────────────────

async function executeSandboxed(
  prompt: string,
  config: ExecutorConfig,
  sandbox: DockerSandbox,
  taskId: string,
  cleanup: () => Promise<void>
): Promise<ExecutionResult> {
  const startTime = Date.now();
  console.log(`  [executor] Running in sandbox (task: ${taskId})`);

  try {
    const output = sandbox.runAgent(taskId, prompt, { model: config.model });

    // Parse stream-json for final result
    const lines = output.split("\n").filter(l => l.startsWith("{"));
    let result = "";
    let turns = 0;
    let subtype = "unknown";
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "result") {
          result = msg.result || "";
          turns = msg.num_turns || 0;
          subtype = msg.subtype || "unknown";
        }
      } catch { /* skip */ }
    }

    const durationMs = Date.now() - startTime;
    const success = subtype === "success";
    console.log(`  [executor] Result: ${subtype} (${turns} turns, ${Math.round(durationMs / 1000)}s)`);

    if (!success) {
      console.error(`  [executor] Error: ${result || subtype}`);
    }

    // Detect billing/auth errors
    const lower = (result || "").toLowerCase();
    if (lower.includes("credit balance") || lower.includes("rate limit") || lower.includes("unauthorized")) {
      console.error(`  [executor] Account error: ${result}`);
      return { success: false, output: result, turns, error: result, durationMs };
    }

    return { success, output: result, turns, durationMs };
  } catch (err: any) {
    console.error(`  [executor] Sandbox error: ${err.message}`);
    return {
      success: false,
      output: "",
      turns: 0,
      error: err.message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await cleanup();
  }
}

// ── Direct Agent SDK execution (fallback) ───────────────────────────

async function executeDirect(
  prompt: string,
  config: ExecutorConfig,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  let turns = 0;
  let output = "";

  console.log(`  [executor] Running directly (no sandbox)`);

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const systemPrompt = loadAgentContext(config.agentContextDir);

    const options: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
      maxTurns: config.maxTurns || 200,
      settingSources: [],
    };

    if (config.cwd) options.cwd = config.cwd;
    if (systemPrompt) options.systemPrompt = systemPrompt;
    if (config.model) options.model = config.model;

    if (config.mcpConfigPath) {
      try {
        const mcpConfig = JSON.parse(readFileSync(config.mcpConfigPath, "utf-8"));
        options.mcpServers = mcpConfig.mcpServers;
      } catch (err) {
        console.warn(`[executor] Could not load MCP config: ${err}`);
      }
    }

    let sessionId = "";

    console.log(`  [executor] Starting agent (model: ${config.model || "default"}, maxTurns: ${options.maxTurns})`);

    for await (const message of query({ prompt, options })) {
      const msg = message as any;

      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id || "";
        if (sessionId) {
          console.log(`  [executor] Session: ${sessionId}`);
          console.log(`  [executor] Log: ~/.claude/projects/*/${sessionId}.jsonl`);
        }
      }

      if (msg.type === "assistant") turns++;

      if (msg.type === "result") {
        output = msg.result || msg.subtype || "";
        const duration = msg.duration_ms ? `${Math.round(msg.duration_ms / 1000)}s` : "";
        console.log(`  [executor] Result: ${msg.subtype} (${turns} turns, ${duration})`);

        if (msg.subtype !== "success") {
          console.error(`  [executor] Error: ${msg.error || msg.result || msg.subtype}`);
        }

        const lower = (output || "").toLowerCase();
        if (lower.includes("credit balance") || lower.includes("rate limit") || lower.includes("unauthorized")) {
          console.error(`  [executor] Account error: ${output}`);
          return { success: false, output, turns, error: output, durationMs: Date.now() - startTime };
        }
      }
    }

    return { success: true, output, turns, durationMs: Date.now() - startTime };
  } catch (err: any) {
    const errorDetail = err.stderr ? `${err.message}\nstderr: ${err.stderr}` : err.message || String(err);
    console.error(`  [executor] Error: ${errorDetail}`);
    return {
      success: false,
      output: output || errorDetail,
      turns,
      error: output ? `${output} (${errorDetail})` : errorDetail,
      durationMs: Date.now() - startTime,
    };
  }
}
