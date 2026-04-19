import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { join, resolve, sep } from "path";
import { DockerSandbox } from "./docker.js";

export { DockerSandbox } from "./docker.js";

/**
 * Refresh the project-local sandbox credentials from the macOS keychain
 * before spawning a sandbox.
 *
 * Why this exists:
 *   In LASTLIGHT_LOCAL_DEV mode the dev-local.sh script seeds
 *   ./data/sandbox-data/claude-home/.credentials.json from the host claude
 *   login at harness startup. But during a long dev session the host's
 *   `claude` CLI will refresh its OAuth token (rotating the access token in
 *   the keychain). When that happens the seeded file becomes stale — the
 *   server invalidates the old access token immediately on rotation, so the
 *   in-sandbox claude starts returning 401 even though the file's recorded
 *   expiresAt is still in the future.
 *
 *   Re-reading the keychain on every sandbox spawn keeps the in-sandbox
 *   credentials current without requiring the user to restart the harness.
 *
 * This is a no-op when:
 *   - LASTLIGHT_LOCAL_DEV is not set (production / Docker harness)
 *   - We're not on macOS
 *   - The keychain entry doesn't exist
 *   - SANDBOX_DATA_VOLUME doesn't look like a host path
 */
function refreshLocalDevCredentials(): void {
  if (process.env.LASTLIGHT_LOCAL_DEV !== "1") return;
  if (process.platform !== "darwin") return;

  const dataVolume = process.env.SANDBOX_DATA_VOLUME;
  if (!dataVolume) return;
  // Only path-like values (the bind-mount form used in local dev)
  if (!dataVolume.startsWith("/") &&
      !dataVolume.startsWith("./") &&
      !dataVolume.startsWith("../") &&
      !dataVolume.startsWith("~")) {
    return;
  }

  let dataDir = dataVolume;
  if (dataDir.startsWith("~")) {
    dataDir = (process.env.HOME || "") + dataDir.slice(1);
  }
  dataDir = resolve(dataDir);

  try {
    const creds = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-a", process.env.USER || "", "-w"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    ).trim();

    if (!creds) return;

    const credPath = join(dataDir, "claude-home", ".credentials.json");
    writeFileSync(credPath, creds);
    chmodSync(credPath, 0o644);
  } catch {
    // Keychain entry missing, security command unavailable, or write failed.
    // Don't fail sandbox creation on this — the existing seeded file may
    // still be valid.
  }
}

/**
 * Clean up orphaned sandbox containers from previous runs.
 * Called on startup to remove containers that survived a harness restart.
 */
export function cleanupOrphanedSandboxes(): void {
  try {
    const out = execFileSync("docker", [
      "ps", "-q", "--filter", "name=lastlight-sandbox",
    ], { encoding: "utf-8", timeout: 5000 });

    const ids = out.trim().split("\n").filter(Boolean);
    if (ids.length > 0) {
      console.log(`[sandbox] Cleaning up ${ids.length} orphaned sandbox container(s)`);
      execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore", timeout: 15000 });
    }
  } catch {
    // Docker not available or no containers — fine
  }
}

const SANDBOX_IMAGE = "lastlight-sandbox:latest";

/**
 * Check if Docker sandbox mode is available.
 */
export function isSandboxAvailable(): boolean {
  return dockerAvailable() && sandboxImageExists(SANDBOX_IMAGE);
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function sandboxImageExists(imageName: string): boolean {
  try {
    const out = execFileSync("docker", ["images", "-q", imageName], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Cached check — only probe Docker once per process */
let _sandboxAvailable: boolean | null = null;

export function sandboxAvailable(): boolean {
  if (_sandboxAvailable === null) {
    _sandboxAvailable = isSandboxAvailable();
    if (_sandboxAvailable) {
      console.log(`[sandbox] Docker sandbox available (image: ${SANDBOX_IMAGE})`);
    } else {
      console.log(`[sandbox] Docker not available — running agents directly`);
    }
  }
  return _sandboxAvailable;
}

function isWithinDir(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * Create a sandbox for a task. Returns the sandbox and a cleanup function.
 * If Docker is not available, returns null (caller should fall back to direct execution).
 */
export async function createTaskSandbox(opts: {
  taskId: string;
  stateDir: string;
  sandboxDir?: string;
  env?: Record<string, string>;
}): Promise<{ sandbox: DockerSandbox; workDir: string; cleanup: () => Promise<void> } | null> {
  if (!sandboxAvailable()) return null;

  // In LASTLIGHT_LOCAL_DEV mode, refresh the project-local claude credentials
  // from the host keychain before each sandbox spawn (handles token rotation
  // during long dev sessions). No-op in production.
  refreshLocalDevCredentials();

  const sandboxBase = resolve(opts.sandboxDir || join(opts.stateDir, "sandboxes"));
  mkdirSync(sandboxBase, { recursive: true });

  const workDir = resolve(sandboxBase, opts.taskId);
  if (!isWithinDir(sandboxBase, workDir)) {
    throw new Error(`Invalid taskId path escape attempt: ${opts.taskId}`);
  }

  mkdirSync(workDir, { recursive: true });

  const sandbox = new DockerSandbox({
    imageName: SANDBOX_IMAGE,
    env: opts.env || {},
    memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || undefined,
  });

  try {
    await sandbox.create({ taskId: opts.taskId, worktreePath: workDir });
    return {
      sandbox,
      workDir,
      cleanup: () => sandbox.destroy(opts.taskId),
    };
  } catch (err: any) {
    console.warn(`[sandbox] Failed to create sandbox: ${err.message}`);
    return null;
  }
}
