# Overlay config reference — `instance/secrets/.env` + `instance/config.yaml`

The server reads config in layers: packaged `config/default.yaml` → overlay
`instance/config.yaml` → `instance/secrets/.env` env vars → `LASTLIGHT_*` env.
Secrets stay env-only and out of git. The container entrypoint copies
`instance/secrets/.env` → `/app/.env` and `instance/secrets/*.pem` → `/app/*.pem`
(mode 600) at boot, and the overlay is mounted read-only at `/app/instance`.

## `instance/secrets/.env`  (mode 0600)

Write exactly these keys. `WEBHOOK_SECRET` and `ADMIN_SECRET` are random 32-byte
hex (`openssl rand -hex 32`). Include only the ONE provider key that matches the
model.

```dotenv
# ── Last Light — Environment Variables ─────────────────────

# Overlay (this deployment's private config + assets)
LASTLIGHT_OVERLAY_DIR=/app/instance

# ── GitHub App (required) ────────────────────────────────
GITHUB_APP_ID=123456
# PEM lives at instance/secrets/app.pem; the entrypoint symlinks it to /app/app.pem.
GITHUB_APP_PRIVATE_KEY_PATH=./app.pem
GITHUB_APP_INSTALLATION_ID=789012

# ── Webhook (required) — must match the GitHub App's webhook secret ──
WEBHOOK_SECRET=<openssl rand -hex 32>

# ── Domain (used by Caddy for TLS) ───────────────────────
DOMAIN=lastlight.example.com

# ── Model + provider API key ─────────────────────────────
LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6
# Set whichever ONE matches LASTLIGHT_MODEL:
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...

# ── Admin dashboard ──────────────────────────────────────
ADMIN_SECRET=<openssl rand -hex 32>
# Optional — protects /admin with a password (>=8 chars):
# ADMIN_PASSWORD=...

# ── Slack (optional) ─────────────────────────────────────
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# SLACK_DELIVERY_CHANNEL=C0123456
# SLACK_ALLOWED_USERS=U0123,U0456
```

Notes:
- `GITHUB_APP_PRIVATE_KEY_PATH=./app.pem` is correct as-is — it's resolved
  inside the container, not on the host. Just place the file at
  `instance/secrets/app.pem`.
- Provider-key detection: `sk-ant-…` is Anthropic; `sk-or-…` is OpenRouter; any
  other `sk-…` is OpenAI.
- **Removing** an env var later requires a container *recreate*
  (`lastlight server start agent`), not just a restart — compose injects
  `env_file` vars at creation time. Adding/changing one only needs
  `lastlight server restart agent`.

## `instance/config.yaml`

Non-secret overlay config, merged over `config/default.yaml`. Arrays replace;
maps deep-merge. Minimum useful content is the managed-repos list:

```yaml
# Last Light — private deployment overlay config
# Merged over config/default.yaml at startup. Restart to apply:
#   lastlight server restart agent
managedRepos:
  - owner/repo
  - owner/another-repo
```

If there are no repos yet, write `managedRepos: []` and tell the user to add
entries before the bot will act. You can also override `models`, `variants`,
`routes`, and `disabled.*` here — see the repo's `config/default.yaml` for the
full shape.

## `instance/.gitignore`

So the overlay can become a private git repo without leaking secrets:

```gitignore
secrets/
*.pem
```

## `instance/docker-compose.override.yml`  (only if Caddy is disabled)

Write this ONLY when the user opts out of Caddy TLS (they terminate TLS
elsewhere). Then symlink it into the working dir as `./docker-compose.override.yml`
(or run `lastlight server setup` / `update`, which ensures the symlink).

```yaml
# Deployment compose override — this deployment opted out of Caddy TLS.
services:
  caddy:
    profiles:
      - disabled
```
