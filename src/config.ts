import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

/**
 * Load .env file into process.env (simple, no dependency).
 * Does not overwrite existing env vars.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export interface LastLightConfig {
  /** Webhook listener port */
  port: number;
  /** GitHub webhook secret for signature verification */
  webhookSecret: string;
  /** Bot login name (for filtering self-events) */
  botLogin: string;
  /** Path to MCP server config */
  mcpConfigPath: string;
  /** SQLite database path */
  dbPath: string;
  /** Directory for all persistent state (sessions, logs, db) — mount this as a Docker volume */
  stateDir: string;
  /** Directory for agent sandboxes (cloned repos per task) */
  sandboxDir: string;
  /** Claude model to use */
  model: string;
  /** Max agent turns */
  maxTurns: number;
  /** GitHub App config */
  githubApp: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
}

/**
 * Load configuration from environment variables and optional config file.
 * Environment variables take precedence over config file values.
 */
export function loadConfig(): LastLightConfig {
  // Load .env for local dev (does not overwrite existing env vars)
  loadDotEnv(resolve(".env"));

  const stateDir = resolve(process.env.STATE_DIR || "./data");

  return {
    port: parseInt(process.env.WEBHOOK_PORT || process.env.PORT || "8644", 10),
    webhookSecret: requireEnv("WEBHOOK_SECRET"),
    botLogin: process.env.BOT_LOGIN || "last-light[bot]",
    mcpConfigPath: process.env.MCP_CONFIG_PATH || resolve("mcp-config.json"),
    stateDir,
    sandboxDir: join(stateDir, "sandboxes"),
    dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db"),
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    maxTurns: parseInt(process.env.MAX_TURNS || "200", 10),
    githubApp: {
      appId: requireEnv("GITHUB_APP_ID"),
      privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
      installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable not set: ${name}`);
  }
  return value;
}

/**
 * Generate MCP config file for the Agent SDK from the GitHub App config.
 */
export function generateMcpConfig(config: LastLightConfig): object {
  return {
    mcpServers: {
      github: {
        command: "node",
        args: [resolve("mcp-github-app/src/index.js")],
        env: {
          GITHUB_APP_ID: config.githubApp.appId,
          GITHUB_APP_PRIVATE_KEY_PATH: resolve(config.githubApp.privateKeyPath),
          GITHUB_APP_INSTALLATION_ID: config.githubApp.installationId,
        },
      },
    },
  };
}
