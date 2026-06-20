---
name: docs-sync
description: Keep Last Light's docs in sync with the code. Use before committing changes to workflows/, skills/, config/default.yaml, src/connectors, src/state, src/engine/router.ts, src/config.ts, src/cli.ts, or agent-context/ — or whenever the docs-check pre-commit hook fires. Maps each changed file to the doc surfaces it affects (the in-repo spec/*.md AND the separate lastlight-www site) and updates them.
---

# docs-sync

Last Light's documentation lives in **two surfaces**, and a code change can
silently invalidate either:

1. **In-repo spec** — `spec/*.md` in this repo (`~/work/lastlight`). This is
   the rebuild-grade contract. It is the **source of truth for the website's
   `/spec/` section**: `lastlight-www/scripts/sync-spec.mjs` copies these files
   into the site at build time. So editing `spec/*.md` here _is_ how you update
   the public spec — no edit in the www repo is needed for spec pages.
2. **Hand-written site** — `~/work/lastlight-www/src/pages/docs/*.astro`,
   `src/pages/*.astro`, `src/data/docs-nav.ts`, `src/pages/llms.txt.ts`. These
   are **not** generated from anything. They drift the most. The www repo is a
   **separate git repo** — changes there are a separate commit/PR.

The recurring failure mode: a workflow or skill is added and neither surface is
updated. This skill exists to close that gap.

## When to run

- The `docs-check` PreToolUse hook nudged you before a `git commit`.
- You added/removed/renamed a workflow, skill, route, env var, CLI command,
  state table, or connector behaviour.
- You're doing a periodic freshness audit.

## Procedure

1. **Find what changed.** Staged: `git -C ~/work/lastlight diff --cached --name-only`.
   Or for a broader review: `git -C ~/work/lastlight diff --name-only <base>`.
2. **Map each changed path → target docs** using the table below.
3. **Establish ground truth from the code, never from memory.** For a workflow,
   read its `workflows/<name>.yaml` (kind, skill, phases) and its permission
   profile in `gitAccessProfileForWorkflow` (`src/workflows/runner.ts`). For a
   route, read `config/default.yaml`. For an env var, grep `process.env`.
4. **Edit the spec** (`spec/*.md`) in this repo. Keep edits surgical — match the
   existing table/section format; don't rewrite files.
5. **Edit the site** in `~/work/lastlight-www`. New workflow pages mirror an
   existing sibling (`src/pages/docs/workflows/issue-comment.astro` is the
   simplest template). Add a `src/data/docs-nav.ts` entry and fix the prev/next
   chain on neighbouring pages.
6. **Verify the site builds:** `cd ~/work/lastlight-www && npx astro check`.
   (Spec changes don't need a www edit, but to preview them on the site run
   `npm run sync-spec` there first.)
7. **Report** which surfaces you touched. Remind that the www repo is a
   **separate commit**.

## Change → docs map

| Changed in `~/work/lastlight` | Update |
|---|---|
| `workflows/<name>.yaml` **added / removed / renamed** | **spec:** `05-router.md` (skill enumeration), `08-skills.md` (catalogue if a new skill), `00-overview.md` + `06-workflow-engine.md` (the "build, triage, review, …" behaviour list). **www:** `src/pages/docs/workflows/overview.astro` (workflow card + trigger table + permissions table), `src/data/docs-nav.ts`, a new `src/pages/docs/workflows/<name>.astro` |
| `config/default.yaml` `routes:` changed | **spec:** `05-router.md` routes/skill-enumeration tables. **www:** `overview.astro` trigger table |
| `config/default.yaml` models / variants / new config keys | **spec:** `02-configuration.md`. **www:** `docs/configuration.astro`, `docs/faq.astro` |
| `skills/<name>/` added / removed / purpose changed | **spec:** `08-skills.md` catalogue ("Used by" column). **www:** the workflow page(s) that reference the skill |
| Permission profile map changed (`gitAccessProfileForWorkflow`, `src/workflows/runner.ts`) | **spec:** profiles section. **www:** `overview.astro` permissions table |
| `src/connectors/**` — new platform, event type, or reply formatting | **spec:** `03-integrations.md`, `04-event-model.md` |
| `src/state/**` — tables, indexes, or store split | **spec:** `10-state.md` (tables + "Current implementation" table) |
| New / renamed **env var** (grep `process.env`) | **spec:** `02-configuration.md`. **www:** `docs/configuration.astro`, `docs/faq.astro`. Also `CLAUDE.md` "Environment" |
| `src/cli.ts` commands | **www:** `docs/local-dev.astro`. Also `CLAUDE.md` "Commands" |
| `src/engine/chat*.ts`, chat skills | **spec:** `11-chat.md`. **www:** `docs/` if user-facing |
| Sandbox / egress / firewall (`src/sandbox/**`) | **spec:** `09-sandbox.md` |

## Don'ts

- Don't edit `lastlight-www/src/content/spec/*` directly — it's overwritten by
  `sync-spec.mjs` from this repo's `spec/`. Edit `spec/` here instead.
- Don't invent phases, fields, or routes. If the YAML doesn't say it, don't
  document it.
- `explore-reply` is **not** a workflow — it's a router continuation handler for
  a paused `explore` run's reply gate. Don't give it a workflow card or nav entry.
