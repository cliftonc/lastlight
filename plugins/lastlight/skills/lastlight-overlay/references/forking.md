# Forking built-in assets with `lastlight fork`

`lastlight fork` copies a built-in asset into the overlay (`instance/`) so your
edited copy shadows the default by logical name. It's host-local — it operates on
the working directory's files, not over HTTP.

Path resolution: an explicit `--home <dir>` wins; otherwise if you're standing in
an overlay it writes there (reading built-ins from the parent checkout); if
you're in a core checkout it writes to `<checkout>/instance`; else it falls back
to `LASTLIGHT_HOME` / the saved server home / `~/lastlight`.

## Commands

```bash
lastlight fork                       # list forkable workflows + agent-context files; marks what's already forked
lastlight fork <workflow>            # e.g. `lastlight fork build`
lastlight fork agent-context         # all of soul.md / rules.md / security.md
lastlight fork agent-context <file>  # a single persona file, e.g. soul.md
```

Flags: `--force` overwrites an existing overlay copy (otherwise existing files
are skipped); `--home <dir>` targets a specific working directory.

## What each fork copies

- **`lastlight fork <workflow>`** copies the workflow YAML
  (`workflows/<name>.yaml`) **plus every prompt and skill its phases reference**
  (`workflows/prompts/*.md`, `skills/<name>/`). So the forked workflow is
  self-contained and editable in the overlay. Existing destinations are skipped
  unless `--force`.
- **`lastlight fork agent-context [file]`** copies the agent "personality" files
  (`agent-context/*.md` — typically `soul.md`, `rules.md`, `security.md`) into
  `instance/agent-context/`. With no file argument it forks all of them; pass a
  filename for just one.

`agent-context` is forked only via the literal `agent-context` target — a bare
name is always treated as a workflow.

## Editing workflow

1. Fork the asset.
2. Edit the copy under `instance/…`.
3. If the overlay is its own git repo, commit + push there.
4. Apply: `lastlight server restart agent` (config/asset overlay change — no
   image rebuild).
5. Confirm with `lastlight server status` (lists forked/overridden assets) and
   the dashboard `/config` view.

## Common targets

- Workflows: `build`, `pr-fix`, `pr-review`, `issue-triage`, `issue-comment`,
  `repo-health`, and the `cron-*` workflows. Run `lastlight fork` to see the live
  list.
- Persona: `soul.md` (voice/identity), `rules.md` (hard rules), `security.md`
  (security posture).
