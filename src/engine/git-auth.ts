import { execSync } from "child_process";
import { createSign } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Configure git globally so that git clone/push/pull work with the
 * GitHub App credentials. Called once before spawning agents.
 *
 * Sets up:
 * - A credential helper that returns a fresh installation token
 * - Bot identity (user.name, user.email) for commits
 *
 * Works in Docker, local dev, CI — no path assumptions.
 */
export async function configureGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  botName?: string;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

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
 */
export async function refreshGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

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
  const res = await fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github+json",
      },
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
