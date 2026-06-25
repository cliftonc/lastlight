---
name: browser-qa
description: Drive a real headless browser against a locally-served web UI and capture screenshot evidence, reporting step-level PASS/FAIL/BLOCKED with extracted DOM text and console errors. Use when a phase on the docker QA image must exercise a rendered UI and attach screenshots — it complements the text-evidence verify/qa-test skills.
version: 1.0.0
tags: [browser, qa, screenshots, evidence]
---

# Browser QA

Drive a web UI with a real headless Chromium and report **step-level
pass/fail with evidence**: extracted DOM text, assertion results, console
errors, and screenshot files. The deliverable is a QA report — partial
coverage with documented failures is the expected output.

This skill is the **browser/screenshot path** that `verify` and `qa-test`
scope out to "a separate docker-gated capability". It only works on the
`lastlight-sandbox-qa:latest` docker image, which bakes in Playwright +
Chromium. You have bash + file tools but **no vision** — you reason over the
driver's JSON stdout (extracted text, assertion results, console errors).
The PNG screenshots are **human evidence only**; you never see them.

This skill uses the **building** skill for installing dependencies and
starting the repo's dev-server.

## When this applies

A phase running on the docker QA image whose target is a **web app** the
repo serves on `localhost` and where rendered-UI behaviour or visual
evidence matters. For a CLI or a curl-able API, use `qa-test`/`verify`
instead — don't launch a browser you don't need.

## FIRST — probe for a browser

The driver lives in this skill's bundle at
`<skill-dir>/scripts/agent-browser.mjs`. Resolve `<skill-dir>` from the
available-skills catalogue (it gives the absolute staged path of this
skill); do not assume a relative path from `$PWD` — the agent's cwd is the
checked-out repo, the bundle is a sibling.

Run the runtime probe before anything else:

```bash
node <skill-dir>/scripts/agent-browser.mjs doctor
```

- Exit 0 with `{"ok":true,"chromium":"..."}` → Chromium is available; proceed.
- Exit non-zero (e.g. `playwright not available …`, or no Chromium — the lean
  default image, or a gondolin run) → **DO NOT attempt browser QA.** Fall back
  to the text path (`verify`/`qa-test` style: curl the dev-server, capture
  stdout) and **say in your report that the browser path was unavailable** and
  you used the text path.

## Start the app

Follow the **building** skill to install dependencies, then start the repo's
dev-server **in the background** and wait until it is listening on
`localhost:PORT` (poll with `curl` until it answers). Note the port — you
pass it as `--base-url`.

## Author a flow

Write a `flow.json` describing the QA flow. Shape:

```json
{
  "baseUrl": "http://localhost:3000",
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    { "name": "home", "goto": "/" },
    { "click": "text=Login" },
    { "fill": ["#email", "a@b.com"] },
    { "type": ["#password", "hunter2"] },
    { "press": "Enter" },
    { "waitFor": "#dashboard" },
    { "assertText": "Welcome" },
    { "text": "h1" },
    { "screenshot": "after-login" }
  ]
}
```

Step keys (a step may combine an action **plus** a trailing `screenshot`):

| Key          | Value                | Effect                                                            |
|--------------|----------------------|------------------------------------------------------------------|
| `goto`       | path or URL          | Navigate (resolved against `baseUrl`). **Failure is fatal.**      |
| `click`      | selector             | Click the element.                                               |
| `fill`       | `[selector, value]`  | Set an input's value.                                            |
| `type`       | `[selector, value]`  | Type key-by-key into an input.                                   |
| `press`      | key (e.g. `Enter`)   | Press a keyboard key.                                            |
| `waitFor`    | selector             | Wait until the element is visible (~10s timeout).                |
| `assertText` | string               | Pass if the text is visible anywhere on the page; else step FAIL.|
| `text`       | selector             | Extract `textContent` into the step result (for you to read).    |
| `screenshot` | basename             | Write `<out-dir>/<basename>.png` (full page).                    |

The whole flow runs in **one Chromium session** — login state, cookies, and
navigation persist across steps.

## Run the flow

```bash
node <skill-dir>/scripts/agent-browser.mjs run flow.json \
  --base-url http://localhost:PORT \
  --out-dir <artifact-dir>
```

The driver prints a single JSON report:

```json
{ "ok": false,
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "index": 0, "action": "goto", "ok": true, "ms": 412 },
    { "index": 6, "action": "assertText", "ok": false, "ms": 10003,
      "error": "assertText not found: \"Welcome\"" },
    { "index": 7, "action": "text", "ok": true, "ms": 5, "text": "Dashboard" },
    { "index": 8, "action": "screenshot", "ok": true, "ms": 88,
      "screenshot": "/…/after-login.png" }
  ],
  "consoleErrors": ["Uncaught TypeError: …"],
  "screenshots": ["/…/after-login.png"] }
```

- A step error (selector not found, assertion miss, timeout) is recorded
  `ok:false` and the run **continues** — best-effort coverage. The exception
  is a `goto` that fails: that is fatal and the remaining steps are skipped.
- `ok` at the top level is true only when **every** step passed. The process
  exits 0 even when steps failed — judge from the JSON, not the exit code.
  A non-zero exit means a fatal harness error (bad flow file, launch failure).

## Screenshots & artifacts

Pass `--out-dir <artifact-dir>` pointing at the run's artifact directory the
**prompt provides** (commonly the run's `.lastlight/<issueKey>/` dir,
referenced as the template variable the prompt passes in). Saving there lets
the harness **harvest** the PNGs into the dashboard Artifacts view. Reference
each screenshot path in your report.

Screenshot delivery requires **server-mode build-assets**. If the PNGs can't
be persisted (no artifact dir was provided, or build-assets is repo-mode),
still report the text/DOM observations and console errors, and say the
screenshots were **not retained**.

## Evidence rules

Mirror `verify`/`qa-test` — you are an investigator, not an advocate:

- **Never fake a pass.** Don't hardcode expected text or edit the code under
  test to force a green step.
- **Report real failures.** A step that genuinely fails is a finding — record
  it `FAIL` with the assertion/selector and the driver's error, and don't bury
  it.
- **Treat `consoleErrors` and page errors as findings**, even if the visible
  flow "worked" — surface them in the report.
- If the browser is unavailable (probe failed), fall back to text and say so —
  don't pretend a UI step ran.

## Report

Produce your report as your **final message** — the workflow posts it for you
(don't `github_add_issue_comment` yourself; that would double-post):

```
## Browser QA: <target>

**Environment:** <branch / commit, package manager, how the app was served,
Chromium version from `doctor`>

### Results
| Step | Status | Evidence |
|------|--------|----------|
| <step description> | PASS / FAIL / BLOCKED | <extracted text / assertion result / screenshot path> |

### Console errors
- <each consoleErrors / pageerror entry, or "none observed">

### Coverage
<what was driven in the browser, and anything not tested and why (e.g. the
probe failed and you fell back to text; screenshots not retained).>
```

Every step in the flow must have a row and a result. Never report a flow as
"passed" with steps you didn't actually run — list them as untested instead.
