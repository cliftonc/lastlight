# lastlight-evals

A standalone, **SWE-bench-compatible** eval harness for [Last
Light](https://github.com/cliftonc/lastlight) workflows. It drives the **real**
production workflows (`issue-triage`, `build`, …) — their actual prompts and
skills — against a **mocked GitHub**, grades the result deterministically, and
prints a model-comparison scorecard. It answers "what do we expect from the
agent, and which model does it best?"

Nothing here talks to real GitHub. The agent's `github_*` tool calls are served
by an in-process fake (seeded + recording), and `git push` goes to a local bare
repo. The only deviations from production are the two we can't do unattended:
approval gates are disabled and outward side-effects are mocked.

```
instance (SWE-bench shape)
   │
   ├─ start fake GitHub (seeded with the issue, records every mutation)
   ├─ (code-fix) seed workspace: fixture repo @ base_commit + local bare origin
   ├─ load the REAL workflow YAML (issue-triage / build / …) from lastlight core
   ├─ runWorkflow(sandbox:"none", githubApiBaseUrl→fake, approvalConfig:{})
   └─ grade:
        • execution  — apply held-out tests, run them → FAIL_TO_PASS / PASS_TO_PASS
        • behavioral — recorded GitHub calls vs the instance's expectations
```

> Working on the harness itself? See `CLAUDE.md` for the seams and invariants
> (the base-URL mock, static-token mode, the no-clone seeding trick, the
> asset-bootstrap footgun, the metrics drain).

## Install

Published on npm. Needs **Node 24+** and a provider API key.

```bash
npm install -g lastlight-evals    # or run ad-hoc with: npx lastlight-evals
```

Installing pulls in `lastlight` (and `agentic-pi`). `lastlight-evals` is a thin
CLI on top of the `lastlight` package: it imports `getWorkflow`, `runWorkflow`,
`ExecutorConfig`, and `TemplateContext` from core's public `lastlight/evals`
entry point, plus the `gh`-repo bootstrap helpers used by `init`. Core ships its
`workflows/`, `skills/`, and `agent-context/` inside the package, so the evals
run the exact same assets production does — that's the whole point.

## What a run does

Each eval `instance` (an issue fixture, optionally with a code fixture + held-out
tests) is taken through the **real** production workflow end to end:

1. An **in-process fake GitHub** starts, seeded with the issue and recording
   every mutating call the agent makes.
2. For `code-fix`, the **workspace is seeded** with the fixture repo at its base
   commit plus a local bare `origin`, so `git push` works fully offline.
3. The **real workflow YAML** (`issue-triage`, `build`, …) is loaded from
   `lastlight` and run with `sandbox:"none"`, the agent's `github_*` tools
   pointed at the fake, and approval gates disabled (so it never pauses).
4. The result is **graded deterministically** — no LLM judge:
   - **behavioral** — the recorded GitHub calls (labels, comments, PRs) vs the
     instance's `expect_github` / `triage_gold`.
   - **execution** (code-fix) — the held-out tests are applied and run; the case
     is *resolved* only if every `FAIL_TO_PASS` passes and every `PASS_TO_PASS`
     stays green (SWE-bench's criterion).
5. Token usage, cost, and latency are collected per run.

Run multiple models and you get a side-by-side **scorecard** (HTML + JSON)
ranking them on pass rate, cost, and latency.

## Run it

```bash
# no tier args → interactively pick which tiers to run (one or all).
# Non-interactive (CI / piped) falls back to the cheapest default.
lastlight-evals run

# name tiers explicitly to skip the prompt
lastlight-evals run triage
lastlight-evals run code-fix            # the full build cycle (heavy)
lastlight-evals run triage code-fix     # both → combined tabbed report

# cross-vendor comparison (OpenAI + Anthropic + open source) — see models.json.
# Families run in PARALLEL; serial within a family. Force serial with --serial.
lastlight-evals run --compare

# pick ONE model (fuzzy-matched against models.json id/label)
lastlight-evals run triage --model haiku
lastlight-evals run triage --model glm,deepseek   # a comma-list also works

# repeat each case N times; verdicts WORST-case, cost/tokens/latency MEAN
lastlight-evals run triage --runs 3

# run against an overlay repo's OWN workflows + datasets (see below)
lastlight-evals run --overlay ~/work/lastlight-instance

# add your own datasets dir without an overlay
lastlight-evals run --datasets ~/my-evals/datasets

# ad-hoc model set / focus one instance / no browser
EVAL_MODELS="openai/gpt-5.5,anthropic/claude-sonnet-4-6" lastlight-evals run
EVAL_INSTANCE=off-by-one lastlight-evals run code-fix
lastlight-evals run triage --no-open
```

The runner opens `index.html` and **rewrites it after every run** (auto-refresh,
preserving the active tab + scroll), so you watch the scorecard fill in live.
Output lands under `./eval-results/<tiers>/` (override with `LASTLIGHT_EVALS_OUT`):

- `index.html` — styled scorecard.
- `scorecard.json` — structured roll-up per model.
- `predictions.jsonl` — SWE-bench predictions shape.

Needs a provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`FIREWORKS_API_KEY` / `OPENROUTER_API_KEY`) in the environment or a cwd `.env`.
The runner exits non-zero **only** if the harness itself errors — a weak model
scoring poorly is the measurement, not a build failure.

## Your own workflows + datasets (overlays)

An **overlay** is a directory (often its own repo, like `lastlight-instance`)
that carries its own `workflows/` / `skills/` / `agent-context/` (which shadow
the core built-ins by name) and its own `evals/datasets/`. One flag wires both:

```bash
lastlight-evals run --overlay ~/work/lastlight-instance     # or LASTLIGHT_OVERLAY_DIR
```

- Overlay **workflows/skills** are layered over core via core's asset overlay
  (same mechanism the production harness uses).
- Overlay **datasets** are discovered at `<overlay>/evals/datasets/<tier>/`, and
  shadow built-in tiers of the same name.
- An overlay **`evals/models.json`** is picked up automatically (or pass
  `--models-file`).

### `lastlight-evals init [dir]` — scaffold a fresh overlay+evals repo

```bash
lastlight-evals init my-evals
cd my-evals && lastlight-evals run --overlay .
```

Scaffolds `workflows/` `skills/` `agent-context/` (empty, to fill in),
`evals/datasets/` + `evals/models.json` (seeded from the shipped samples),
`config.yaml`, and a `.gitignore`/`README`, then offers to `git init` + create a
private GitHub repo via `gh` (reusing core's `lastlight server setup` flow).

## Datasets & tiers

A **tier** is a directory containing `instances.json` (+ an optional `tier.json`
declaring its `defaultWorkflow`). Tiers are discovered from three roots, merged
by name with **overlay > user (`--datasets`) > built-in** precedence:

- **built-in** (shipped here): `triage` → `issue-triage`, `code-fix` → `build`.
- **user**: `--datasets <dir>` / `LASTLIGHT_EVALS_DATASETS`.
- **overlay**: `<overlay>/evals/datasets/*`.

### Add a case

**Triage** — append to a tier's `instances.json`:

```json
{
  "instance_id": "triage__my-case",
  "repo": "lastlight-evals/widget",
  "workflow": "issue-triage",
  "problem_statement": "short title",
  "issue": { "number": 110, "title": "…", "body": "…", "labels": [] },
  "triage_gold": { "category": "bug", "state": "ready-for-agent" },
  "expect_github": { "labels_added": ["bug"] }
}
```

**Code-fix** — three things keyed by `instance_id`, all under the tier dir:

```
<tier>/instances.json     # the SweBenchInstance (FAIL_TO_PASS / PASS_TO_PASS)
<tier>/repos/<id>/        # fixture repo at base_commit (NO held-out tests)
<tier>/tests/<id>/        # held-out test files, copied in at grade time
```

A new tier just needs a directory with an `instances.json` and a `tier.json`
(`{ "name", "defaultWorkflow", "description" }`); per-instance `workflow` wins
when present.

## Models (`models.json`)

- `default` — the single model `run` uses.
- `compare` — the cross-vendor set `--compare` fans out over. Each entry has an
  `id` (the agentic-pi/pi-ai `provider/model` spec), a `label`, and an `envKey`.
  **An entry only runs if its `envKey` is present**, so the compare set
  auto-trims to whatever keys you have.

## Roadmap

- **`lastlight-evals extract <owner>/<repo>#<n>`** — generate eval cases from
  GitHub historical issues/PRs (issue → fixture, merged PR → held-out tests).
- Docker-backed runs; real SWE-bench Lite ingestion; per-fixture test runners.
- LLM-as-judge stays out by design — grading is deterministic.
