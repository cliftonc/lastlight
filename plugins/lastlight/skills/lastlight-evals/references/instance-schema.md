# Eval instance schema & authoring cases

An eval case is a **`SweBenchInstance`** — SWE-bench-compatible core fields plus
Last Light extensions (the GitHub fixtures + behavioral expectations that let the
harness drive and grade the real workflow against a mocked GitHub).

Datasets are discovered from (overlay > user > built-in): `<overlay>/evals/datasets/`,
`--datasets <dir>` / `LASTLIGHT_EVALS_DATASETS`, and the package's built-in
`datasets/`. A tier is a directory with a `tier.json` and an `instances.json`.

## `tier.json`

```json
{ "name": "triage", "defaultWorkflow": "issue-triage", "description": "..." }
```

## `SweBenchInstance` fields

```jsonc
{
  // ── SWE-bench core ──
  "instance_id": "triage__my-case",      // unique id
  "repo": "owner/repo",                   // logical; fixture origin is a local bare repo
  "base_commit": "0000000...",            // code-fix only
  "problem_statement": "short issue text",
  "patch": "...",                          // gold patch — reference only, NOT graded
  "test_patch": "...",                     // held-out tests (code-fix)
  "FAIL_TO_PASS": ["test id 1"],          // must go red→green (code-fix)
  "PASS_TO_PASS": ["test id 2"],          // must stay green (code-fix)

  // ── Last Light extensions ──
  "workflow": "issue-triage",             // optional; defaults to the tier's defaultWorkflow
  "issue": {                               // seed state for the fake GitHub
    "number": 110, "title": "...", "body": "...",
    "labels": [], "user": "alice",
    "comments": [{ "user": "bob", "body": "..." }],
    "state": "open"
  },
  "triage_gold": { "category": "bug", "state": "ready-for-agent" },  // triage grading
  "expect_github": {                       // behavioral assertions on recorded GitHub calls
    "labels_added": ["bug"],
    "labels_absent": ["wontfix"],
    "issue_closed": false,
    "comment_matches": "(?i)thanks",
    "pr_opened": { "base": "main", "head_is_branch": true, "title_matches": "(?i)fix" }
  }
}
```

Every `expect_github` field is optional — only the present ones are checked.

## Add a triage case

Append a `SweBenchInstance` to `datasets/triage/instances.json` with `issue`,
`triage_gold`, and the `expect_github` assertions (e.g. `labels_added`). That's
it — triage is graded on the triage decision + GitHub mutations.

## Add a code-fix case (three things, keyed by `instance_id`)

1. **`datasets/code-fix/instances.json`** — append the instance with
   `base_commit`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `issue`, and `expect_github`
   (e.g. `pr_opened`).
2. **`datasets/code-fix/repos/<instance_id>/`** — the fixture repo at the base
   commit (the buggy code *before* the fix; no held-out tests here).
3. **`datasets/code-fix/tests/<instance_id>/`** — the held-out test files, copied
   into the repo at grade time and run to compute `FAIL_TO_PASS` / `PASS_TO_PASS`.

## Add a custom tier

Create `datasets/<tier-name>/` with `tier.json` (`name`, `defaultWorkflow`,
`description`) + `instances.json`. For code-fix-style tiers also add `repos/<id>/`
and `tests/<id>/`. Discovery auto-finds it — no code change. Run it with
`lastlight-evals run <tier-name> --overlay .`.

## Grading (how a case passes)

- **Behavioral:** did the workflow take the expected GitHub actions
  (`expect_github`)?
- **Triage:** did the decision match `triage_gold`?
- **Execution (code-fix):** all `FAIL_TO_PASS` green AND all `PASS_TO_PASS` still
  green after applying held-out tests.
- With `--runs N` (N>1) the binary verdict is **worst-case** (passes only if every
  trial passed); the scorecard also shows per-verdict pass counts to expose
  variance.
