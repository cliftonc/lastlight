/**
 * Persisted CLI config — `~/.lastlight/config.json`.
 *
 * Stores the instance URL and bearer token that `lastlight login` obtains, so
 * every subsequent command runs against the same remote instance without
 * re-authenticating. The file holds a credential, so it is written mode 0600
 * inside a 0700 directory.
 *
 * Env vars (`LASTLIGHT_URL` / `LASTLIGHT_TOKEN`) always take precedence over
 * the file — see `resolveTarget()` — so CI/scripts can override without
 * touching disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  /** Base URL of the Last Light instance, e.g. https://ll.example.com */
  url: string;
  /** Bearer token minted by the instance (7-day TTL). */
  token: string;
  /** ISO timestamp the token was saved — informational. */
  savedAt: string;
}

export const DEFAULT_URL = "http://localhost:8644";

/** `~/.lastlight` — the CLI config directory. */
export function configDir(): string {
  return path.join(os.homedir(), ".lastlight");
}

/** `~/.lastlight/config.json` — the saved-credentials file. */
export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** Load the saved config, or null if none / unreadable. */
export function loadConfig(): CliConfig | null {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token, savedAt: parsed.savedAt ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist `{ url, token }`. Creates `~/.lastlight/` (mode 0700) if missing and
 * writes the file mode 0600. `savedAt` is stamped automatically.
 */
export function saveConfig(cfg: { url: string; token: string }): CliConfig {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full: CliConfig = { url: cfg.url, token: cfg.token, savedAt: new Date().toISOString() };
  fs.writeFileSync(configPath(), JSON.stringify(full, null, 2) + "\n", { mode: 0o600 });
  // mkdir/writeFile honour `mode` only on creation; enforce on existing files too.
  try {
    fs.chmodSync(configPath(), 0o600);
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort — non-POSIX filesystems may reject chmod */
  }
  return full;
}

/** Remove the saved config (logout). No-op if it doesn't exist. */
export function clearConfig(): void {
  try {
    fs.rmSync(configPath());
  } catch {
    /* already gone */
  }
}

/**
 * Resolve the effective instance URL + token the CLI should use for a command.
 * Precedence: explicit override (`--url`/`--token`) → env → saved file →
 * built-in default URL (with no token).
 */
export function resolveTarget(override?: { url?: string; token?: string }): {
  url: string;
  token: string;
} {
  const saved = loadConfig();
  const url =
    override?.url ||
    process.env.LASTLIGHT_URL ||
    saved?.url ||
    DEFAULT_URL;
  const token =
    override?.token ||
    process.env.LASTLIGHT_TOKEN ||
    saved?.token ||
    "";
  return { url: url.replace(/\/+$/, ""), token };
}
