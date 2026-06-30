# Author an eval case from a real GitHub PR or issue

`lastlight-evals add-case` turns a real GitHub **PR** into a code-fix (build) case
or an **issue** into a triage case. It does the mechanical, reproducible
extraction with `gh` + `git`; **you** refine the judgement parts. The result is a
**git-source** case — no fixture repo is vendored; at run time the harness clones
the repo into the gitignored `./.eval-cache/` and checks out `base_commit` (see
the `instance-schema.md` "Git-source" flavor).

> **Trust + network.** Validation and the run-time checkout execute the repo's own
> code (`setup_cmd` / `test_cmd` / its tests). Only point this at repos you trust.
> The first run per repo fetches over the network; after that the cache makes it
> offline.

## Prerequisites

- `gh` on PATH and authenticated (`gh auth login`) — used to read PR/issue metadata.
- `git`. Node 24+ (same as the rest of the harness).

## Command

```bash
lastlight-evals add-case --pr <github-pr-url> [options]
lastlight-evals add-case --issue <github-issue-url> [options]
```

Options:

| flag | meaning |
|---|---|
| `--pr <url>` | a GitHub PR url → a **code-fix** (build) case |
| `--issue <url>` | a GitHub issue url → a **triage** case |
| `--tier <name>` | target tier dir (default `code-fix` for `--pr`, `triage` for `--issue`) |
| `--id <slug>` | `instance_id` (default derived from repo + number) |
| `--datasets <dir>` | datasets root to write into (a `<tier>/` subdir). Default `./datasets`, else `./evals/datasets` |
| `--overlay <dir>` | write into `<dir>/evals/datasets` instead |
| `--test-cmd "<cmd>"` | held-out test command (default `node --test`); stored as `test_cmd` |
| `--setup-cmd "<cmd>"` | install/build run before tests (e.g. `"npm ci"`); stored as `setup_cmd` |
| `--no-validate` | don't run the repo's tests to auto-detect `FAIL_TO_PASS` (just scaffold) |
| `--dry-run` | print the proposed instance JSON; don't write |

## The recommended flow (CLI extracts → you refine)

1. **Dry-run first.** `add-case --pr <url> --dry-run` prints the proposed instance.
   The CLI derives:
   - `repo`, `base_commit` (the **merge-base** of the base branch and the PR head —
     the true fork point, not the base-branch tip), and `head_commit`;
   - `test_patch` — the diff of the PR's **test** files (path heuristic: `test/`,
     `tests/`, `__tests__/`, `spec/`, or `*.test.*` / `*.spec.*` / `*_test.*`);
   - gold `patch` — the diff of the non-test files (reference only, never graded);
   - `FAIL_TO_PASS` / `PASS_TO_PASS` — auto-detected by running the tests at base
     (with `test_patch` applied → expect red) then at head (→ expect green), unless
     `--no-validate`;
   - `issue` + `problem_statement` (the PR's linked issue if it closes one, else the
     PR title/body) and `expect_github: { pr_opened: { base, head_is_branch } }`.

2. **Review and repair** what the CLI can't get right on its own:
   - **Held-out tests.** If the heuristic mislabeled files (warns "No test files
     detected", or grabbed a non-test), fix `test_patch` by hand, or rely on the
     repo's in-repo tests via `--test-cmd`.
   - **Verdicts.** If validation couldn't run (custom runner, deps), set
     `FAIL_TO_PASS` to the genuinely bug-revealing test name(s). Leave it **empty
     for suite mode** (graded on the test command's exit code) when the runner
     emits no TAP names.
   - **Problem statement.** Tighten it to what the agent should act on — drop PR
     chatter; keep the bug description.
   - **`test_cmd` / `setup_cmd`** for non-`node --test` repos, e.g.
     `--test-cmd "npm test" --setup-cmd "npm ci"`.

3. **Write it.** Re-run without `--dry-run` (add `--datasets <dir>` / `--overlay
   <dir>` to target a specific workspace). The instance is appended to
   `<root>/<tier>/instances.json` (creating `tier.json` if the tier is new).

4. **Verify end-to-end.** Run the case with the cheapest model just to confirm the
   plumbing — the sandbox seeds from the real repo at `base_commit` and grading
   runs the held-out tests:

   ```bash
   EVAL_INSTANCE=<instance_id> lastlight-evals run code-fix --model haiku
   ```

## Test runners & grading

- **`node --test` (default).** Emits TAP; the CLI extracts per-test names and grades
  each `FAIL_TO_PASS` / `PASS_TO_PASS` by name.
- **Any other runner via `--test-cmd`.** If it emits TAP with stable names, named
  grading still works. Otherwise the case runs in **suite mode**: `FAIL_TO_PASS`
  stays empty and the case is resolved iff the test command exits 0 (after the
  held-out `test_patch` is applied). Use `--setup-cmd` for install/build.

## Triage from an issue

`add-case --issue <url>` builds a triage case from a **resolved** issue — its
content plus the human triage outcome:

- `problem_statement` + the `issue` seed from the title/body. **Seed labels are
  emptied on purpose** so the agent triages from scratch (the applied labels are
  the gold it must reproduce, not an input).
- `expect_github.labels_added` = the labels that were applied to the issue (read
  from the issue **events** API, so the evidence block also shows *who* applied
  each — maintainer vs bot), and `issue_closed: true` if the issue was closed.
- An **evidence block** prints the applied labels and the reviewer comments
  (author + first line) — the raw signal you turn into the gold decision.

What you refine before running:

- **`triage_gold`** (`{ category, state }`) — assign from the applied labels per
  **the deployment's triage taxonomy** (the CLI can't know which label is the
  category vs the workflow state, so it leaves `triage_gold` empty). `gradeTriage`
  checks these label strings end up on the issue.
- **Prune** any non-triage labels (e.g. `good first issue`) out of `labels_added`.
- **Reviewer comments** — optionally turn a representative one into a
  `comment_matches` regex (asserting the agent's triage comment covers the same
  point), or move a genuinely *pre-triage* maintainer comment into `issue.comments`
  as context the agent should see.

See `instance-schema.md` for the full triage field reference.
