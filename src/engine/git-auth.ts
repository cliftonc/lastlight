import { execSync } from "child_process";
import { createSign } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

export type GitHubPermissionLevel = "read" | "write";

/**
 * Subset of GitHub App installation-token permissions supported by Last Light.
 * Any omitted permission inherits the app's installation defaults.
 */
export type GitHubTokenPermissions = Partial<{
  contents: GitHubPermissionLevel;
  issues: GitHubPermissionLevel;
  pull_requests: GitHubPermissionLevel;
  metadata: GitHubPermissionLevel;
}>;

/**
 * When true, all `git config --global` writes are skipped. The harness still
 * mints installation tokens and passes them to sandboxes via the GIT_TOKEN env
 * var, but the host's `~/.gitconfig` is left untouched. Set
 * `LASTLIGHT_LOCAL_DEV=1` when running the harness on your dev machine so it
 * doesn't overwrite your personal git identity or credential helper.
 */
function isLocalDev(): boolean {
  return process.env.LASTLIGHT_LOCAL_DEV === "1";
}

/**
 * Configure git globally so that git clone/push/pull work with the
 * GitHub App credentials. Called once before spawning agents.
 *
 * Sets up:
 * - A credential helper that returns a fresh installation token
 * - Bot identity (user.name, user.email) for commits
 *
 * Works in Docker, local dev, CI — no path assumptions.
 *
 * In local dev mode (LASTLIGHT_LOCAL_DEV=1) the global git config is NOT
 * modified — the host's identity and credential helper are left alone. The
 * token is still returned and propagates to sandboxes via env, where the
 * sandbox-entrypoint.sh sets up its own per-container credential helper.
 */
export async function configureGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  botName?: string;
  /**
   * Optional repository-name allowlist for the minted installation token.
   * Names are repo names within the installation owner (e.g. ["lastlight"]).
   */
  repositories?: string[];
  /** Optional per-token permission downscoping. */
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

  if (isLocalDev()) {
    console.log(`[git-auth] LOCAL DEV MODE — skipping global git config writes. ` +
      `Token is still passed to sandboxes via GIT_TOKEN env (expires: ${token.expiresAt}).`);
    return token;
  }

  // Set up credential helper — git will call this for any github.com URL
  const credHelper = `!f() { echo "username=x-access-token"; echo "password=${token.token}"; }; f`;
  exec(`git config --global credential.helper '${credHelper}'`);

  // Bot identity
  const botName = config.botName || "last-light";
  exec(`git config --global user.name "${botName}[bot]"`);
  exec(`git config --global user.email "${botName}[bot]@users.noreply.github.com"`);

  console.log(`[git-auth] Configured git with GitHub App token (expires: ${token.expiresAt})`);

  return token;
}

/**
 * Refresh the git credential helper with a fresh token.
 * Call this if a push/pull fails with auth errors.
 *
 * In local dev mode the global git config is left alone — the fresh token is
 * returned to the caller (executor.ts) which forwards it to the sandbox via
 * env so the in-container credential helper picks it up.
 */
export async function refreshGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  /**
   * Optional repository-name allowlist for the minted installation token.
   * Names are repo names within the installation owner (e.g. ["lastlight"]).
   */
  repositories?: string[];
  /** Optional per-token permission downscoping. */
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

  if (isLocalDev()) {
    return token;
  }

  const credHelper = `!f() { echo "username=x-access-token"; echo "password=${token.token}"; }; f`;
  exec(`git config --global credential.helper '${credHelper}'`);

  console.log(`[git-auth] Refreshed token (expires: ${token.expiresAt})`);
  return token;
}

// ── Internal ────────────────────────────────────────────────────────

async function getInstallationToken(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  repositories?: string[];
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");

  // Generate JWT (RS256, no external dependency)
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: config.appId })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  const jwtToken = `${header}.${payload}.${signature}`;

  // Exchange for installation token
  const requestBody: Record<string, unknown> = {};
  if (config.repositories && config.repositories.length > 0) {
    requestBody.repositories = config.repositories;
  }
  if (config.permissions && Object.keys(config.permissions).length > 0) {
    requestBody.permissions = config.permissions;
  }
  const hasRequestBody = Object.keys(requestBody).length > 0;

  const res = await fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github+json",
        ...(hasRequestBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasRequestBody ? JSON.stringify(requestBody) : undefined,
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at };
}

function exec(cmd: string): void {
  execSync(cmd, { stdio: "pipe" });
}
