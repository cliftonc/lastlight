# Executor Summary — #119 Slack commands

## What was done

Replaced every user-/agent-facing string that advertised a leading-slash
"command" with the natural-language phrasing the router classifier actually
understands. No `app.command` handlers added (by design — Slack slash commands
require dashboard config outside this repo, and the architecture is
deliberately classifier-first).

### Files changed

- `src/engine/chat.ts` — rewrote `CHAT_SYSTEM_SUFFIX`:
  - 5 intent reply lines (security, triage, review, build) → `tell me '…'` phrasings.
  - `/health` line → warn-and-surface message (health reports are cron/CLI only; no interactive Slack health command).
  - Added an explicit "Never suggest messages that start with a slash" rule before the STYLE block.
  - Removed the trailing "Useful commands you can suggest" footer (it duplicated the per-intent list and contained leading slashes).
- `skills/chat/SKILL.md` — frontmatter `description` and the "What you don't do" bullet list now use natural-language triggers; added the no-leading-slash rule.
- `skills/issue-comment/SKILL.md` — frontmatter `description`: `/build` → `@last-light build`.
- `src/engine/dispatcher.ts:125` — double-run reply: `Use /status` → `Say "status"`.
- `src/workflows/CLAUDE.md:255` — replaced the false "Slack slash" approval bullet with the real Slack-message path (`approve` / `reject <reason>`).
- `skills/README.md:17` — chat skill row: "guide to slash commands" → "guide users to the natural-language workflow triggers".

### Test added

- `src/engine/chat.test.ts` (new) — regression guard asserting `CHAT_SYSTEM_SUFFIX` contains no `` `/\w+ `` tokens, uses the natural-language phrasings, warn-and-surfaces health (no `` `/health` ``), and explicitly forbids leading-slash suggestions.

## Test / lint / typecheck results

```
$ npx tsc --noEmit
(no output) — exit 0

$ (cd dashboard && npx tsc -b)
(no output) — exit 0

$ npx vitest run
 Test Files  49 passed (49)
      Tests  727 passed (727)
   Duration  10.96s
```

No linter is configured (non-blocking), per the guardrails report.

## Deviations from the plan

- The plan suggested wording the anti-slash instruction line as
  "`triage owner/repo`, not `/triage owner/repo`". That counter-example
  itself contains a `` `/\w+ `` token, which the regression test
  (correctly) flags. I reworded the line to
  "Always phrase triggers as natural language (e.g. `triage owner/repo`,
  never a leading-slash command)." so the prompt contains zero backticked
  slash tokens while still conveying the rule. The regression test's
  "forbids" assertion was adjusted accordingly (matches `/never suggest.*slash/i`).
  Behaviourally equivalent; no other deviations.

## Known issues

None. No logic/routing/classifier changes — string and doc edits only.
