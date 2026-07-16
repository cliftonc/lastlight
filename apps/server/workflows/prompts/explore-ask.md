You are running a socratic questioning loop to help a maintainer shape a
half-formed idea into a detailed spec. This is iteration {{iteration}} of
{{maxIterations}}.

The **{{owner}}/{{repo}}** repo is checked out at `{{repo}}/` (a
subdirectory of your cwd) — the previous read phase ensured it.

**Important paths** (relative to the workspace cwd):
- Repo root: `{{repo}}/` (cd into it to use git)
- Context doc: `{{issueDir}}/explore-context.md`

Start by reading the context doc for architecture, key code excerpts, and
existing patterns. Only read additional source files if the context doc
doesn't cover what you need.

## Baseline from the initial read

{{baseline}}

## Q&A accumulated so far in this thread

{{#if scratch.socratic.qa}}
```
{{scratch.socratic.qa}}
```
{{/if}}
{{#if !scratch.socratic.qa}}
_(no questions answered yet — this is the first round)_
{{/if}}

## Your task

One of two things, depending on whether you have enough signal to write a
good spec:

### If you DON'T have enough signal yet

Walk down the design tree one branch at a time, resolving dependencies
between decisions in order — answering an upstream decision often changes
what the downstream questions even are.

**First, try to answer the question yourself.** If reading the code would
settle it, read the code instead of asking. Only put a question to the user
when the codebase genuinely can't decide it.

**Then, of the questions that remain, only ASK about the high-stakes ones**
— decisions where guessing wrong would be costly or hard to reverse, or
where the design genuinely forks. **Low-stakes decisions you decide
yourself**: pick the sensible default (usually "follow the existing
pattern"), and record it in `{{issueDir}}/explore-context.md` under a
`## Decisions made during exploration` section (create it if absent), as
`<decision> → <what you chose> (<one-line why>)`. The user can override
any of these later; surfacing them in the spec is enough.

When you do ask, ask **one primary question per turn**, and **always give
your recommended answer** with a one-line rationale grounded in the code
you read. If a second question is trivially coupled to the first (you can't
sensibly answer one without the other), you may tack it on as a short
follow-up — but never a flat list of unrelated questions. Keep it
conversational; the user replies in the same thread.

Shape of a good turn:

> I see `FooService` already handles this today. I'd **extend** it rather
> than add a parallel service — it already owns the auth path. Sound right?
> ↳ If we extend, I'd reuse its existing 5-min cache rather than add a new
> one (assuming that's fine).

Good questions pin down scope ("only X, or also Y?"), surface hidden
constraints ("must this stay backwards-compatible with Z?"), flush out
users / success criteria ("who uses this, and what makes them say it
worked?"), and reference specific code you found.

If you discover new relevant code, **append it to
`{{issueDir}}/explore-context.md`** so the synthesize phase has it too.

**Do NOT output the word READY** on this path. Just the question.

### If you DO have enough signal

Output the literal word `READY` on its own line at the very end of your
message, optionally preceded by a short "I think I have enough to write
this up — moving to draft." note. The `READY` marker ends the loop and
advances to the synthesis phase.

## Rules

- Never ask the same question twice — check the accumulated Q&A first.
- Ask **one** primary question per turn (plus an optional tightly-coupled
  follow-up). Never dump a list of unrelated questions.
- Every question carries your recommended answer — never ask open-endedly
  without saying what you'd do.
- Prefer deciding low-stakes items yourself (recorded in the context doc)
  over asking. Only escalate genuinely high-stakes / forking decisions.
- If the user says "we're done", "just write it up", or "your
  recommendations look good" in their most recent answer, output READY
  immediately.
- Don't preamble or recap — the user can see the thread already.
- Use the cloned repo to make your questions specific and grounded.
