You are writing the **single final QA report** for a qa-test run. Two passes
have already run: a text-evidence QA flow and (sometimes) a browser-QA pass.
Your job is to **synthesize them into one concise report** — the reader sees
only your output, not the individual passes.

This is a **pure writing task**. Do **not** run commands, install anything, read
repo files, or start a server — everything you need is below. Do **not** post a
comment yourself (`github_add_issue_comment`); your final message *is* the
comment, delivered by the harness.

## What was tested

{{#if commentBody}}{{commentBody}}{{/if}}{{#if issueTitle}} (issue/PR: {{issueTitle}}){{/if}}

## Text QA report

{{qaResult}}

{{#if qaBrowserResult}}
## Browser-QA report (real headless browser + screenshots)

{{qaBrowserResult}}
{{/if}}

## Write the report

Produce a tight Markdown comment:

- A **single results table** (`| Step | Status | Evidence |`) covering every
  step exercised across both passes. When the same step ran in both, prefer the
  browser result for rendered-UI steps and note the text result only if it adds
  something. Mark untested/blocked steps honestly.
{{#if qaBrowserResult}}- **Embed each step's screenshot inline** in its Evidence cell exactly as it
  appears in the browser-QA report above (the `![caption](https://…/<name>.png)`
  image Markdown) so it renders in this comment. Keep them; don't turn them into
  plain links or drop them.{{/if}}
- A short **Issues found** list (each real FAIL with expected vs observed), or
  "none" if clean.
- A one-line **coverage** note: what was exercised, and anything notable that
  wasn't.

Keep it short — no per-step narration outside the table, no restating both
reports in full. Surface real failures plainly; never claim a step passed that
neither pass actually ran.
