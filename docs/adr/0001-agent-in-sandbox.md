# 1. The agent runs inside the sandbox, not just its tools

Status: Accepted

Date: 2026-06-29

## Context

A workflow phase hands an LLM agent real capability against a target repo:
shell (`bash`), filesystem writes (`write`/`edit`), and network egress, plus a
GitHub App installation token. Much of what the agent acts on is
attacker-influenced — an issue body, a PR diff, a comment — so a phase must be
assumed to be running partially untrusted instructions. The security question is
therefore not "do we trust this agent" but "**where is the boundary** that
contains it when a prompt injection convinces it to misbehave."

Two shapes answer that question differently:

- **Agent-in-sandbox** — the entire agent runtime (`agentic-pi`) runs *inside*
  the isolation boundary (a gondolin micro-VM or a Docker container). The
  agent's reasoning, every tool it calls, and its outbound network all sit on
  the inside.
- **Tools-in-sandbox** — the agent runs in-process on the host as a library, and
  only the tool calls that need isolation are marshalled out (e.g. `bash` /
  `write` via `docker exec`), with read-only tools running on the host. This was
  the explicitly-considered "Option A" in `docs/pi-migration-plan.md`
  (SUPERSEDED).

## Decision

**The whole agent process runs inside the sandbox.** Tools are not individually
routed out to an isolated executor; the isolation boundary wraps the runtime
itself. The harness mints a per-run, profile-downscoped GitHub token and forwards
LLM provider keys *into* that boundary, and the boundary applies a default-deny
network egress policy from the outside (see `spec/09-sandbox.md`).

## Alternatives considered

**Tools-in-sandbox (rejected).** Running the agent on the host and dispatching
only write-capable tools through a `DockerExecutor` was a real candidate. It was
rejected because it **moves the trust boundary from one place to each individual
tool implementation**. As the superseded migration plan put it:

> The risk we accept: a tool author who forgets to route through the executor
> gets host-level access by accident. We mitigate this with **structural**
> controls (lint, registration audit, runtime guard), not just behavioral tests.

That is a boundary you have to actively defend in every tool, forever — a single
unrouted `fs`/`child_process` import silently re-grants host access. The
agent-in-sandbox model makes containment **structural by construction**: there
is no host-side code path for an agent tool to escape through, because the agent
isn't on the host.

## Consequences

**Positive**

- One trust perimeter. Default-deny egress, the scoped token, and the isolated
  filesystem are all enforced at the *process edge*, not re-checked per tool
  call. A `read`-profile triage run literally cannot push code or reach the host,
  even if a prompt-injected attacker convinced the agent to try.
- New tools inherit isolation for free — there is no "did I remember to route
  this through the executor" failure mode, and no lint rule standing in for a
  real boundary.
- The boundary is swappable without touching tool code: gondolin micro-VM
  (default), Docker container, or smol micro-VM all implement the same Sandbox
  port (`src/sandbox/sandbox.ts`).

**Negative**

- Heavier per-phase startup: each phase clones into and boots a fresh
  VM/container rather than calling a library in-process.
- For local development the cost isn't worth it, so the in-process escape hatches
  exist: `InProcessSandbox` with `mode: none` (no isolation) or `mode: gondolin`.
  These are dev/opt-in, not the production default.

## See also

- `spec/09-sandbox.md` — the full Sandbox contract, backends, egress firewall,
  and token downscoping.
- `src/engine/github/profiles.ts` — the `read` / `issues-write` / `review-write`
  / `repo-write` profiles whose scoping only means something *because* the agent
  can't step outside the boundary that enforces them.
- `docs/pi-migration-plan.md` (SUPERSEDED) — where the tools-in-sandbox
  alternative ("Option A") was weighed in full.
