import { execFileSync, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFileCb);

/**
 * Docker sandbox manager — runs agent tasks in isolated sibling containers.
 *
 * The sandbox image bakes immutable assets at /app/ (skills, agent-context,
 * MCP server, MCP config template). Its entrypoint wires them into the
 * workspace after volumes are mounted — no post-run docker exec needed.
 *
 * Volumes mounted at runtime:
 * - Shared data volume (/data): Claude auth, secrets (app.pem), session logs
 * - Task worktree (/home/agent/workspace): per-task git repo
 */

export interface SandboxConfig {
  /** Docker image for sandbox containers (default: lastlight-sandbox:latest) */
  imageName: string;
  /** Env vars to inject into the sandbox */
  env: Record<string, string>;
  /** Timeout in seconds (default: 1800 = 30 min) */
  timeoutSeconds?: number;
}

export interface SandboxInfo {
  containerId: string;
  containerName: string;
  worktreePath: string;
}

const WORKSPACE_DIR = "/home/agent/workspace";

export class DockerSandbox {
  private config: SandboxConfig;
  private activeContainers: Map<string, SandboxInfo> = new Map();

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /**
   * Create and start a sandbox container for a task.
   */
  async create(opts: {
    taskId: string;
    worktreePath: string;
  }): Promise<SandboxInfo> {
    const containerName = `lastlight-sandbox-${opts.taskId}-${randomUUID().slice(0, 8)}`;
    const worktreePath = resolve(opts.worktreePath);

    // The shared data volume — contains claude auth, session logs, sandboxes
    const volumeName = process.env.SANDBOX_DATA_VOLUME || "lastlight_agent-data";

    const volumes = [
      `${volumeName}:/data`,                   // shared state (claude-home, sessions)
      `${worktreePath}:${WORKSPACE_DIR}`,      // task worktree
    ];

    // Resolve git mounts for worktrees (if .git is a file pointing elsewhere)
    const gitMounts = this.resolveGitMounts(worktreePath);
    volumes.push(...gitMounts);

    // Env flags — passed to entrypoint for MCP config template expansion
    const envFlags = Object.entries(this.config.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    // The entrypoint runs as root to fix permissions, then drops to agent via gosu.
    // No --user flag needed.
    const args = [
      "run", "-d",
      "--name", containerName,
      ...envFlags,
      ...volumes.flatMap(v => ["-v", v]),
      "-w", WORKSPACE_DIR,
      this.config.imageName,
    ];

    try {
      // The entrypoint handles all setup: claude auth, skills, CLAUDE.md,
      // .mcp.json, and git config. No docker exec calls needed.
      const containerId = execCmd("docker", args).trim();

      const info: SandboxInfo = { containerId, containerName, worktreePath };
      this.activeContainers.set(opts.taskId, info);
      console.log(`[sandbox] Created: ${containerName}`);

      // Wait for entrypoint to finish setting up auth, skills, MCP config.
      // The entrypoint drops to `gosu agent sleep infinity` when done —
      // we detect readiness by checking for the .credentials.json symlink.
      await this.waitForReady(containerName);

      return info;
    } catch (err: any) {
      throw new Error(`Failed to create sandbox: ${err.message}`);
    }
  }

  /**
   * Wait for the sandbox entrypoint to finish setup.
   * Polls for the credentials symlink in the agent's home directory.
   */
  private async waitForReady(containerName: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    const interval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await execFileAsync("docker", [
          "exec", "--user", "agent", containerName,
          "test", "-f", "/home/agent/.claude/.credentials.json",
        ], { timeout: 5000 });
        // File exists — entrypoint is done
        return;
      } catch {
        // Not ready yet — wait and retry
        await new Promise((r) => setTimeout(r, interval));
      }
    }

    console.warn(`[sandbox] Timed out waiting for ${containerName} to be ready — proceeding anyway`);
  }

  /**
   * Run the Claude CLI inside the sandbox with a prompt.
   * Runs asynchronously — does not block the event loop.
   */
  async runAgent(taskId: string, prompt: string, opts?: { model?: string }): Promise<string> {
    const info = this.activeContainers.get(taskId);
    if (!info) throw new Error(`No sandbox for task ${taskId}`);

    const model = opts?.model || "claude-sonnet-4-6";
    const timeout = this.config.timeoutSeconds || 1800;

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const cmd = [
      "claude",
      "--print", "--verbose",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--model", model,
      "-p", `'${escapedPrompt}'`,
    ].join(" ");

    // Run as agent user — Claude Code blocks --dangerously-skip-permissions as root
    const args = ["exec", "--user", "agent", "-w", WORKSPACE_DIR, info.containerName, "sh", "-c", cmd];

    try {
      const { stdout } = await execFileAsync("docker", args, {
        encoding: "utf-8",
        timeout: timeout * 1000,
        maxBuffer: 50 * 1024 * 1024, // 50MB — agent output can be large
      });
      return stdout;
    } catch (err: any) {
      const stderr = err.stderr?.toString() || "";
      const stdout = err.stdout?.toString() || "";
      throw new Error(`Sandbox agent failed (exit ${err.status}): ${stderr || stdout || err.message}`);
    }
  }

  /**
   * Remove a sandbox container.
   */
  async destroy(taskId: string): Promise<void> {
    const info = this.activeContainers.get(taskId);
    if (!info) return;

    execSafe("docker", ["rm", "-f", info.containerName]);
    this.activeContainers.delete(taskId);
    console.log(`[sandbox] Destroyed: ${info.containerName}`);
  }

  async destroyAll(): Promise<void> {
    for (const taskId of this.activeContainers.keys()) {
      await this.destroy(taskId);
    }
  }

  private resolveGitMounts(worktreePath: string): string[] {
    const gitPath = join(worktreePath, ".git");
    if (!existsSync(gitPath)) return [];

    try {
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitdirPath = match[1];
        const parentGitDir = resolve(gitdirPath, "..", "..");
        return [
          `${gitPath}:${gitPath}`,
          `${parentGitDir}:${parentGitDir}`,
        ];
      }
    } catch { /* fall through */ }

    return [`${gitPath}:${gitPath}`];
  }
}

function execCmd(cmd: string, args: string[], opts?: { timeout?: number }): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts?.timeout,
  });
}

function execSafe(cmd: string, args: string[]): void {
  try { execFileSync(cmd, args, { stdio: "ignore" }); } catch { /* ignore */ }
}
