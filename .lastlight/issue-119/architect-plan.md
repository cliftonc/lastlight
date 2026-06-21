# Architect Plan — #119 Slack commands v3

Branch: `lastlight/119-slack-commands-v3`

## Problem Statement

The chat agent's system prompt advertises fake Slack slash commands that don't
exist. `CHAT_SYSTEM_SUFFIX` in `src/engine/chat.ts:45-77` tells the agent to
reply with `run \`/security owner/repo\``, `run \`/triage owner/repo\``, `run
\`/review owner/repo\``, `run \`/health owner/repo\``, `run \`/build
owner/repo#N\``, and lists "Useful commands you can suggest: `/build …`,
`/triage …`, `/review …`, `/security …`, `/health …`, `/status`". Slack
intercepts any message starting with `/` *before* it reaches Last Light (the
Slack connector at `src/connectors/slack/connector.ts:148-191` registers only
`app.message` + `app_mention` — no `app.command`), so every suggestion the
agent makes fails the way the reporter experienced (`/health is not a valid
command`). The `skills/chat/SKILL.md` description and body repeat the same
`/build`, `/triage`, `/review`, `/status` slash notation, reinforcing the bug.
The maintainer explicitly does **not** want real slash commands wired up —
they want the chat agent to respond with **natural-language examples** of how
to invoke Last Light for what it can actually do.

## Summary of what needs to change

Reword every slash-command suggestion in the chat agent's prompt surface to
use natural-language phrasing (e.g. "tell me `triage owner/repo`" or "say
`build owner/repo#N`") instead of leading-slash notation. Align the listed
capabilities with what the router/classifier actually support as interactive
Slack intents: `build`, `triage`, `review`, `security`, `explore`, `question`,
`status`, `reset`, `approve`, `reject` — and explicitly note that `health` is
**not** an interactive Slack intent (repo-health runs via cron/CLI only), so
the agent should not suggest it as an interactive trigger. Update the chat
skill's SKILL.md frontmatter description and body to match. Add a regression
test asserting the compiled chat system prompt contains no leading-slash
command tokens and does advertise the natural-language triggers.

## Files to modify

### 1. `src/engine/chat.ts` — `CHAT_SYSTEM_SUFFIX` (lines 18-78)

Rewrite the `CHAT_SYSTEM_SUFFIX` template literal so that:

- The "DO NOT ATTEMPT DEEP WORK IN-PROCESS" routing bullets reply with
  **natural-language** examples instead of `run \`/x owner/repo\``:
  - security → "tell me `security review owner/repo`"
  - triage → "tell me `triage owner/repo`"
  - review → "tell me `review PRs on owner/repo`"
  - build → "tell me `build owner/repo#N`" (keep the "open the GitHub issue
    first if needed" parenthetical)
  - Remove the `health` bullet entirely (no interactive health intent
    exists), OR reword it to surface the truth: "weekly health reports run
    on a cron schedule, not on demand from chat — ask a maintainer to
    configure the repo-health cron, or run `npm run cli -- health
    owner/repo` from the harness host." Prefer the reworded surface-the-truth
    form so a health request is **warn-and-surfaced**, not silently dropped.
- The "Useful commands you can suggest:" footer (lines 75-77) is replaced
  with a "Natural-language triggers you can suggest:" block listing the
  actual interactive intents as plain phrases, **no leading slashes**:
  `build owner/repo#N`, `triage owner/repo`, `review PRs on owner/repo`,
  `security review owner/repo`, `explore owner/repo`, `status`, `reset`,
  `approve`, `reject`.
- Add one explicit rule line: "Never suggest commands with a leading `/`
  — Slack intercepts them before they reach Last Light and they will fail.
  Always phrase triggers as natural language the user can type as a plain
  message."
- Keep the rest of the suffix (WHAT YOU CAN DO / WHAT YOU CANNOT DO /
  security disclosure rule / STYLE) unchanged.

Exact anchor: the whole template literal assigned to
`export const CHAT_SYSTEM_SUFFIX = \`...\`;` starting at line 18 and closing
at line 78 (the backtick + `;` after the `/status\`` line).

### 2. `skills/chat/SKILL.md` — frontmatter `description` (line 3) + body (lines 19-26)

- Line 3 frontmatter `description:` — replace
  `...guide users to slash commands like /build, /triage, /review, /status.`
  with `...guide users to natural-language triggers (e.g. "build owner/repo#N", "triage owner/repo", "review PRs on owner/repo", "status").`
- Lines 19-26 "What you don't do" section — replace the slash-command bullet
  list with natural-language triggers:
  - code changes → `build owner/repo#N`
  - issue triage → `triage owner/repo`
  - PR review → `review PRs on owner/repo`
  - security scan → `security review owner/repo`
  - running-task status → `status`
- Add a one-line rule after the bullets: "Phrase triggers as natural
  language — never with a leading `/`, which Slack intercepts before it
  reaches Last Light."

### 3. `skills/README.md` — chat skill row (line 17)

- Update the table row for `chat`: change
  `...guide to slash commands.` to
  `...guide to natural-language triggers.`

### 4. `src/engine/chat.test.ts` — NEW FILE

Add a regression test (the chat prompt had no direct test coverage — this
bug shipped because nothing asserted the prompt's shape). Create
`src/engine/chat.test.ts` with:

- A `describe("CHAT_SYSTEM_SUFFIX")` block that:
  - imports `CHAT_SYSTEM_SUFFIX` from `./chat.js`;
  - asserts the suffix does **not** contain any of the forbidden slash
    tokens: `/build`, `/triage`, `/review`, `/security`, `/health`,
    `/status` as command suggestions. Use a regex that catches a `/`
    immediately followed by one of those words at a word boundary, e.g.
    `expect(CHAT_SYSTEM_SUFFIX).not.toMatch(/\/(build|triage|review|security|health|status)\b/)`;
    (the security-disclosure line references `agent-context/security.md`
    which contains no such token, so this is safe).
  - asserts the suffix **does** advertise the natural-language triggers:
    `build owner/repo#N`, `triage owner/repo`, `review PRs on owner/repo`,
    `security review owner/repo`, `status` (as plain text, no leading
    `/`).
  - asserts the suffix includes the "never suggest commands with a
    leading `/`" rule.

### 5. `src/engine/chat-skills.test.ts` — NEW FILE (optional but recommended)

The chat skill catalogue is built at boot from `skills/*/SKILL.md`
frontmatter. Add a test that loads the `chat` skill's frontmatter
description and asserts it contains no `/build`/`/triage`/`/review`/
`/status` slash tokens. This locks the SKILL.md edit against regression.
Use the existing `loadChatSkills` (or inline `readFileSync` of
`skills/chat/SKILL.md`) — match whatever `src/engine/chat-skills.ts`
exports; if `loadChatSkills` is not exported, read the file directly and
parse the frontmatter with the same minimal parser the module uses, or
simply assert against the raw file contents via `readFileSync`.

## Commands

Copy verbatim from `.lastlight/issue-119/guardrails-report.md`:

- Tests: `npx vitest run` (full suite) — 48 files, 726 tests expected green.
- Typecheck (server): `npx tsc --noEmit`
- Typecheck (dashboard): `npx tsc -b dashboard` (not touched by this change,
  but run for completeness if desired)
- Lint: not configured (non-blocking).

The executor must run `npx tsc --noEmit` and `npx vitest run` after edits
and paste fresh output into the summary.

## Implementation approach

1. Edit `src/engine/chat.ts` — rewrite `CHAT_SYSTEM_SUFFIX` per file #1.
   Keep the template literal a single export; do not change any other
   symbol in the file.
2. Edit `skills/chat/SKILL.md` per file #2.
3. Edit `skills/README.md` per file #3.
4. Create `src/engine/chat.test.ts` per file #4.
5. Create `src/engine/chat-skills.test.ts` per file #5 (if
   `loadChatSkills` is importable; otherwise a raw-file assertion).
6. Run `npx tsc --noEmit` — must be clean.
7. Run `npx vitest run` — must be 49 files / 728+ tests green (two new
   test files added).
8. Commit with intent-first message:
   `fix(chat): replace fake slash-command suggestions with natural-language triggers (#119)`
   with `Tested: npx tsc --noEmit && npx vitest run` and
   `Scope-risk: chat prompt + chat skill only; no routing/classifier change`.

## Risks and edge cases

- **`health` intent gap** — there is no interactive `health` Slack intent
  (classifier.ts:22 has no `health`; router.ts routes no `health` case).
  The plan **must not** advertise `health owner/repo` as an interactive
  trigger — that would recreate the bug for a different word. Behaviour for
  a "give me a health report on X" chat request: **warn-and-surface** — the
  agent replies that health reports run on cron / CLI only and tells the
  user how to actually get one. This is explicit in the rewritten suffix
  (file #1). Never silently drop it.
- **Forbidden-token regex false positives** — the `agent-context/security.md`
  reference and the `/proc/sys/etc` line in the suffix contain `/` followed
  by words, but not any of `build|triage|review|security|health|status` at a
  word boundary. The test regex `/\/(build|triage|review|security|health|status)\b/`
  is scoped to the exact command words, so it won't fire on prose. The
  executor should verify by running the test; if a legitimate prose hit
  appears, tighten the regex to require the command to be preceded by a
  backtick or start-of-line rather than weakening the assertion.
- **Classifier/router drift** — this change is prompt-only. It does NOT
  alter `classifier.ts` or `router.ts`. The natural-language triggers
  listed in the new prompt already work today (the router classifies them
  and dispatches to the right workflow). No routing change is in scope.
- **Other surfaces that mention `/build`** — `skills/issue-comment/SKILL.md:3`
  says "redirect anything that needs code changes to /build". That skill
  runs on GitHub issue/PR comments, not Slack, and the `/build` there is
  shorthand for "@last-light build" (a natural-language trigger on GitHub).
  It is out of scope for this Slack-focused issue; do NOT edit it. If the
  executor finds additional Slack-facing slash references during
  implementation, surface them in the summary rather than editing
  out-of-scope files.
- **Dashboard / session-jsonl** — no change; the shim and dashboard read
  the compiled system prompt at runtime but don't hard-code slash tokens.

## Test strategy

- **New unit tests** in `src/engine/chat.test.ts` assert the compiled
  `CHAT_SYSTEM_SUFFIX` is free of leading-slash command tokens and contains
  the natural-language triggers. This is the direct regression guard for
  the bug.
- **New unit test** in `src/engine/chat-skills.test.ts` asserts the
  `chat` SKILL.md frontmatter description is slash-free.
- **Existing suite** (`npx vitest run`) must stay green — the change is
  prompt text only, so no existing test should regress. The
  `chat-runner.test.ts` retry tests are unaffected (they test
  `completeWithRetry`, not the prompt).
- **Typecheck** `npx tsc --noEmit` must be clean — the only TS change is
  the new test file(s), which import an already-exported symbol.
- **Manual verification** (optional, not blocking): after deploy, DM the
  Slack bot "what can you do?" and confirm the reply uses natural-language
  triggers with no leading slashes.

## Estimated complexity

**Simple** — prompt/skill text rewording plus two small regression test
files. No routing, classifier, connector, or schema changes. ~1 file
edited for logic (`chat.ts`), 2 markdown edits, 2 new test files.
