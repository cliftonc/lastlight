---
name: lastlight-evals
description: Scaffold, configure and run a Last Light EVALS workspace — the harness that runs Last Light's real workflows against a mocked GitHub and grades them deterministically. Use when the user wants to "set up / scaffold Last Light Evals", "create an evals workspace or instance", "run evals", "compare models", or author new eval cases (triage / code-fix instances). GitHub is mocked, so no real GitHub token is needed — only a model provider API key.
version: 1.0.0
tags: [lastlight, evals, benchmark, models, swe-bench]
---

# Set up & run Last Light Evals

`lastlight-evals` runs Last Light's **real** production workflows (issue-triage,
build, …) end-to-end against a mocked GitHub, grades the results deterministically
(no LLM-as-judge), and compares models on pass rate, cost, and latency. It's a
thin CLI on top of the `lastlight` core package (via the `lastlight/evals`
barrel), so it exercises the same workflows/skills production does. SWE-bench
compatible. **Node 24+.**

## 1. Check prerequisites

```bash
node --version    # need >= 24
command -v lastlight-evals >/dev/null && echo "installed" || npm i -g lastlight-evals
```

## 2. Scaffold a workspace

```bash
lastlight-evals init my-evals       # or: lastlight-evals init  (→ ./lastlight-evals-workspace)
```

This scaffolds an **overlay + evals** workspace:
- `workflows/`, `skills/`, `agent-context/` — empty dirs for override assets
- `evals/datasets/` — seeded from the built-in `triage` + `code-fix` samples
- `evals/models.json` — a copy of the built-in model registry
- `config.yaml`, `.gitignore`, `README.md`
- optionally `git init` + a private `gh repo create`

## 3. Configure providers (`.env`)

Create `.env` in the workspace with **at least one** provider key. GitHub is
mocked end-to-end, so **no real GitHub token is needed** (the harness sets a
dummy one internally).

```dotenv
# any one (or more) of:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
FIREWORKS_API_KEY=fw-...
OPENROUTER_API_KEY=sk-or-...
DEEPSEEK_API_KEY=...
```

Useful optional vars: `EVAL_MODELS` (comma-list override), `LASTLIGHT_EVALS_OUT`
(scorecard dir, default `./eval-results/`), `LASTLIGHT_CORE_DIR` (point at a local
lastlight checkout to eval un-published asset edits), `CI=1` (don't open a
browser). See **`references/models-json.md`** for the model registry format and
how `--compare` is key-gated.

## 4. Run

```bash
cd my-evals
lastlight-evals run --overlay .                 # default model, triage tier
lastlight-evals run triage --overlay .          # one tier
lastlight-evals run triage code-fix --overlay . # multiple tiers
lastlight-evals run triage --model haiku        # fuzzy match in models.json
lastlight-evals run triage --model openai/gpt-5.5,anthropic/claude-opus-4-8
lastlight-evals run --compare                   # cross-vendor set (only models whose envKey is present)
lastlight-evals run triage --runs 3             # repeat each case 3× (worst-case verdict, mean metrics)
lastlight-evals run triage --no-open            # don't open the report
```

Output lands in `./eval-results/<tiers>/`: `index.html` (scorecard),
`scorecard.json`, `predictions.jsonl` (SWE-bench format). Re-render a report
without re-running: `lastlight-evals report ./eval-results/triage`.

## 5. Author eval cases (optional)

Two tiers ship: **triage** (cheap, issue-triage) and **code-fix** (heavy, build
workflow with held-out tests). To add cases or a custom tier, read
**`references/instance-schema.md`** — it has the `SweBenchInstance` schema, the
exact files to create for each tier, and worked examples.

Quick shape:
- **Triage case:** append a `SweBenchInstance` to `datasets/triage/instances.json`
  with `issue`, `triage_gold`, and `expect_github`.
- **Code-fix case:** add the instance to `datasets/code-fix/instances.json` **and**
  create `datasets/code-fix/repos/<instance_id>/` (fixture repo at base) +
  `datasets/code-fix/tests/<instance_id>/` (held-out tests applied at grade time).
- **Custom tier:** a new `datasets/<tier>/` with `tier.json` +
  `instances.json` (+ `repos/` & `tests/` for code-fix-style tiers). Discovery is
  automatic — no code change.

## Done when

The workspace is scaffolded, `.env` has a working provider key, and a run
produces a scorecard under `eval-results/`. Report the workspace path, the
provider(s) configured, and the command to run/compare.
