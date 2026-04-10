import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveModel, loadConfig } from './config.js';
import type { ModelConfig } from './config.js';

describe('resolveModel', () => {
  const models: ModelConfig = {
    default: 'claude-sonnet-4-6',
    architect: 'claude-opus-4-6',
    chat: 'claude-haiku-4-5-20251001',
  };

  it('returns per-type override when present', () => {
    expect(resolveModel(models, 'architect')).toBe('claude-opus-4-6');
  });

  it('returns per-type override for chat', () => {
    expect(resolveModel(models, 'chat')).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to default when no override exists', () => {
    expect(resolveModel(models, 'unknown-type')).toBe('claude-sonnet-4-6');
  });

  it('falls back to default for empty string type', () => {
    expect(resolveModel(models, '')).toBe('claude-sonnet-4-6');
  });
});

// For loadConfig tests we must ensure GITHUB_APP_ID is unset so the
// function doesn't try to require companion GitHub App env vars.
describe('loadConfig — port resolution', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns default port 8644 when no port env vars set', () => {
    vi.stubEnv('WEBHOOK_PORT', '');
    vi.stubEnv('PORT', '');
    const config = loadConfig();
    expect(config.port).toBe(8644);
  });

  it('uses PORT env var when WEBHOOK_PORT is absent', () => {
    vi.stubEnv('WEBHOOK_PORT', '');
    vi.stubEnv('PORT', '9000');
    const config = loadConfig();
    expect(config.port).toBe(9000);
  });

  it('WEBHOOK_PORT takes precedence over PORT', () => {
    vi.stubEnv('WEBHOOK_PORT', '7777');
    vi.stubEnv('PORT', '9000');
    const config = loadConfig();
    expect(config.port).toBe(7777);
  });
});

describe('loadConfig — model resolution', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns default model claude-sonnet-4-6 when CLAUDE_MODEL not set', () => {
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  it('uses CLAUDE_MODEL env var when set', () => {
    vi.stubEnv('CLAUDE_MODEL', 'claude-opus-4-6');
    const config = loadConfig();
    expect(config.model).toBe('claude-opus-4-6');
  });
});

describe('loadConfig — model overrides via CLAUDE_MODELS', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns default-only model config when CLAUDE_MODELS not set', () => {
    vi.stubEnv('CLAUDE_MODELS', '');
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('claude-sonnet-4-6');
  });

  it('parses valid CLAUDE_MODELS JSON and sets per-type overrides', () => {
    vi.stubEnv('CLAUDE_MODELS', JSON.stringify({ architect: 'claude-opus-4-6', chat: 'claude-haiku-4-5-20251001' }));
    const config = loadConfig();
    expect(config.models.architect).toBe('claude-opus-4-6');
    expect(config.models.chat).toBe('claude-haiku-4-5-20251001');
  });

  it('gracefully handles invalid CLAUDE_MODELS JSON and falls back to defaults', () => {
    vi.stubEnv('CLAUDE_MODELS', 'not-valid-json');
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('claude-sonnet-4-6');
  });
});

describe('loadConfig — structure', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns a config with expected keys', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('models');
    expect(config).toHaveProperty('stateDir');
    expect(config).toHaveProperty('dbPath');
    expect(config).toHaveProperty('maxTurns');
  });

  it('maxTurns defaults to 200', () => {
    vi.stubEnv('MAX_TURNS', '');
    const config = loadConfig();
    expect(config.maxTurns).toBe(200);
  });
});
