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

export interface SlackConfig {
  /** Bot User OAuth Token (xoxb-...) */
  botToken: string;
  /** App-Level Token for Socket Mode (xapp-...) */
  appToken: string;
  /** Comma-separated Slack user IDs allowed to interact */
  allowedUsers: string[];
  /** Channel ID for cron report delivery */
  deliveryChannel?: string;
}

/**
 * Per-task-type model configuration.
 * Keys are session types (matching admin dashboard labels).
 * Values are Claude model IDs.
 */
export interface ModelConfig {
  /** Default model for all tasks */
  default: string;
  /** Per-type overrides */
  [taskType: string]: string;
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
  /** Default Claude model (used when no per-type override exists) */
  model: string;
  /** Per-task-type model overrides */
  models: ModelConfig;
  /** Max agent turns */
  maxTurns: number;
  /** GitHub App config (optional — not needed for messaging-only mode) */
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
  /** Slack connector config (present when SLACK_BOT_TOKEN is set) */
  slack?: SlackConfig;
}

/**
 * Load configuration from environment variables and optional config file.
 * Environment variables take precedence over config file values.
 */
export function loadConfig(): LastLightConfig {
  // Load .env for local dev (does not overwrite existing env vars)
  loadDotEnv(resolve(".env"));

  const stateDir = resolve(process.env.STATE_DIR || "./data");

  // GitHub App config is optional — allows messaging-only mode
  const githubApp = process.env.GITHUB_APP_ID
    ? {
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
        installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
      }
    : undefined;

  // Slack config is optional — only if SLACK_BOT_TOKEN is set
  const slack = process.env.SLACK_BOT_TOKEN
    ? {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: requireEnv("SLACK_APP_TOKEN"),
        allowedUsers: (process.env.SLACK_ALLOWED_USERS || "").split(",").filter(Boolean),
        deliveryChannel: process.env.SLACK_DELIVERY_CHANNEL || process.env.SLACK_HOME_CHANNEL || undefined,
      }
    : undefined;

  return {
    port: parseInt(process.env.WEBHOOK_PORT || process.env.PORT || "8644", 10),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    botLogin: process.env.BOT_LOGIN || "last-light[bot]",
    mcpConfigPath: process.env.MCP_CONFIG_PATH || resolve("mcp-config.json"),
    stateDir,
    sandboxDir: join(stateDir, "sandboxes"),
    dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db"),
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    models: parseModelConfig(),
    maxTurns: parseInt(process.env.MAX_TURNS || "200", 10),
    githubApp,
    slack,
  };
}

/**
 * Parse per-task-type model config from CLAUDE_MODELS env var.
 *
 * Format: JSON object mapping session types to model IDs.
 * Example: {"architect":"claude-opus-4-6","chat":"claude-haiku-4-5-20251001"}
 *
 * Session types: guardrails, architect, executor, reviewer, fix, pr, pr-fix,
 *                resume, triage, review, health, chat
 */
function parseModelConfig(): ModelConfig {
  const defaultModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const config: ModelConfig = { default: defaultModel };

  const modelsEnv = process.env.CLAUDE_MODELS;
  if (modelsEnv) {
    try {
      const parsed = JSON.parse(modelsEnv);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            config[key] = value;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[config] Invalid CLAUDE_MODELS JSON: ${err.message}`);
    }
  }

  return config;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable not set: ${name}`);
  }
  return value;
}

/**
 * Resolve the model to use for a given task type.
 * Checks per-type overrides first, then falls back to default.
 */
export function resolveModel(models: ModelConfig, taskType: string): string {
  return models[taskType] || models.default;
}

/**
 * Generate MCP config file for the Agent SDK from the GitHub App config.
 */
export function generateMcpConfig(config: LastLightConfig): object {
  const mcpServers: Record<string, unknown> = {};

  if (config.githubApp) {
    mcpServers.github = {
      command: "node",
      args: [resolve("mcp-github-app/src/index.js")],
      env: {
        GITHUB_APP_ID: config.githubApp.appId,
        GITHUB_APP_PRIVATE_KEY_PATH: resolve(config.githubApp.privateKeyPath),
        GITHUB_APP_INSTALLATION_ID: config.githubApp.installationId,
      },
    };
  }

  return { mcpServers };
}
