# agentic-pi

A pre-configured, opinionated wrapper around [earendil-works/pi](https://github.com/earendil-works/pi)
that turns it into a **one-shot coding-agent worker** for workflow systems like
[lastlight](https://github.com/cliftonc/lastlight).

If you already have an orchestrator that wants to spawn an agent for one
phase (architect, build, review, triage, …), pipe a prompt in, and parse a
structured event stream back out, this is what slots in. It does the
boring wiring so you don't have to.

## What this is opinionated about

Pi itself is a deliberately minimal harness — it gives you an SDK, a multi-provider
LLM API, an extension model, and four run modes. agentic-pi makes opinionated
choices on top of all of that for one specific use case:

### 1. One-shot only, no interactive mode

The only command is `agentic-pi run`. It reads the prompt from **stdin**, runs
exactly one agent turn (which may contain many tool calls), emits JSONL to
**stdout**, and exits when Pi's `agent_end` fires. There is no REPL, no chat
loop, no `serve` mode. If a phase needs follow-ups, the orchestrator spawns a
new process.

### 2. JSONL event stream tailored for downstream parsing

Pi natively emits a JSONL event stream in `--mode json`. agentic-pi uses Pi's SDK
in-process, subscribes to the same events, and adds three things on top:

- A leading `{"type":"session", "version":3, "id":<uuid>, "cwd":...}` header.
- `sessionId` and `timestamp` injected onto **every** subsequent event, so a
  downstream consumer can correlate without parsing the header line separately.
- A terminal `{"type":"usage_snapshot", "stats":{...}}` event synthesized from
  `session.getSessionStats()` — because Pi's per-event payloads do **not**
  carry token counts or cost.

If your orchestrator needs cost/token accounting, the snapshot is the
single line you parse.

### 3. GitHub repo operations as first-class native tools

Pi explicitly does not support MCP. agentic-pi ships a native Pi extension
exposing **31 GitHub tools** ported from lastlight's `mcp-github-app`:
clone/push, issues, PRs, reviews, labels, search. Tools are registered with
the `github_` prefix to match opencode's MCP-server-name convention.

Auth is opinionated: **GitHub App credentials preferred**, static
`GITHUB_TOKEN` only as a low-trust fallback. JWT-minted installation tokens
cached for ~50 minutes, 5-minute refresh buffer, `git credential-store`
file written with mode 600 and a regex-validated token.

### 4. Permission profiles as a registration-time gate

`--profile <name>` picks one of four allowlists ported from lastlight:

| Profile | Tool count | What it can do |
| --- | --- | --- |
| `read` | 18 | Repo/issue/PR reads + search. No mutations. |
| `issues-write` | 24 | Read + issue/comment/label mutations. |
| `review-write` | 26 | Read + issues + PR review/comment + create PR. |
| `repo-write` | 31 | Everything: clone, push, branch, file edits, merge. |

Tools outside the active profile are **never registered** — the LLM cannot see
them in the system prompt and cannot call them. This is a stronger guarantee
than a runtime "ask each time" gate.

The extension is **safe by default** when credentials are missing or
mis-configured:

| Situation | Behaviour | Stderr warning? |
| --- | --- | --- |
| `--profile` not passed | Silent skip. No GitHub tools registered. | No |
| `--profile X`, no `GITHUB_*` env vars at all | Skip. Run continues without GitHub tools. | Yes |
| `--profile X`, partial App creds (e.g. APP_ID set but INSTALLATION_ID missing) | Skip with explicit error. | Yes |
| `--profile X`, App creds set but PEM file unreadable | Skip with explicit error. | Yes |
| `--profile X`, all App creds set and PEM readable | Tools registered. | No |
| `--profile X`, only `GITHUB_TOKEN` set | Tools registered (static-token mode, lower trust). | No |

The `extension_status` JSONL event always reports `status`, `reason`,
`message`, `profile`, and `toolCount` so the orchestrator can log the
outcome programmatically without parsing stderr.

### 5. Models named the way opencode names them

`--model provider/id` accepts the exact string format opencode used
(`openai/gpt-5.5`, `anthropic/claude-opus-4-5`, etc.). Credentials come from
environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) or Pi's `~/.pi/agent/auth.json` if you've logged in
interactively. Provider/id mapping is delegated to `@earendil-works/pi-ai`'s
`getModel()`.

`--thinking <level>` maps directly to Pi's `thinkingLevel`
(`off`/`minimal`/`low`/`medium`/`high`/`xhigh`). Per-provider effort is
handled by Pi.

### 6. Things accepted but ignored for caller-side compatibility

- `--dangerously-skip-permissions` — Pi has no permission prompts to skip
  ("run in a container" is Pi's design stance). The flag is accepted so a
  caller that previously spawned opencode does not need to strip it.
- `--variant <level>` — alias for `--thinking`.

### 7. Defaults that match a containerized sandbox

- **`--no-session`** is intended to be the default in sandboxed runs (state
  lives outside the container).
- **Built-in tools** (read, write, edit, bash, grep, find, ls) are enabled
  by default. Add `--no-builtin-tools` if you want a GitHub-only agent.
- **`AGENTS.md`** in the working directory is auto-loaded as the agent's
  system prompt — same convention Pi and opencode share. Drop your
  workflow's `AGENTS.md` into the mounted workspace and the agent picks it
  up.

### 8. Optional micro-VM sandboxing via `--sandbox gondolin`

By default Pi's file and bash tools run on the host. Pass `--sandbox gondolin`
and they get routed through a per-run [Gondolin](https://github.com/earendil-works/gondolin)
QEMU micro-VM instead. The orchestrator doesn't need to manage anything —
agentic-pi boots the VM, mounts the working directory at `/workspace`
inside it, runs the agent's tools through it, and tears it down on
`agent_end`.

**What this protects against.** Arbitrary code the agent runs via `bash`
or `write` executes inside the VM, not on the host. A prompt-injection
that gets the agent to `rm -rf /` only rm's the guest, which is thrown
away seconds later. The host workspace is mounted in, so legitimate file
edits *do* persist — destructive `bash` against `/workspace` will still
modify host files (the same trade-off `chroot` and Docker bind mounts
have).

**What this does NOT protect against.** GitHub credentials and the LLM
API key live in the agentic-pi process *outside* the VM. The `github_*`
tools run there. A prompt-injection that subverts Pi into calling
`github_create_issue` does not need to escape the VM — the call happens
host-side. The VM protects against *code execution*, not *tool misuse*.
For protection against tool misuse, restrict the GitHub profile
(`--profile read`).

**Hard requirements.**

- QEMU on the host: `brew install qemu` (macOS) or
  `apt install qemu-system-x86 qemu-system-arm qemu-utils` (Debian/Ubuntu).
- agentic-pi running **natively** on the host, not inside a Docker
  container. See `SPIKE-gondolin.md`: managed-host containers don't
  expose `/dev/kvm`, and macOS Docker uses Apple's
  Virtualization.Framework (not KVM), which is unreachable from inside
  a container.
- On Linux, the running user must have read access to `/dev/kvm`.

**Pre-flight is loud, not silent.** agentic-pi probes for QEMU and
`qemu-img` before starting the VM, and probes the booted VM with
`/bin/true` (5s timeout) before returning. If any check fails, the
process exits 2 with a clean error pointing at the spike doc. The
upstream `VM.create` failure mode of "returns ready but the guest is
dead" cannot leak through.

**Latency cost (measured on macOS Apple Silicon).**

| Op | Time |
| --- | --- |
| First `VM.create` post-boot | ~13 s (one-time cache warm-up) |
| Subsequent `VM.create` | < 100 ms |
| Per-tool overhead | ~200 ms each |
| Realistic shell op (`ls /etc && uname -a`) | ~2.8 s |
| `vm.close` | ~10 ms |

Linux + KVM should be in the same ballpark. Numbers are reproducible
from `test/fixtures/phase3-smoke-sandbox-gondolin.jsonl`.

**Event stream.** A `sandbox_status` JSONL line is emitted right after
the session header:

```jsonl
{"type":"sandbox_status","backend":"gondolin","status":{"backend":"gondolin","cwd":"/path/to/workspace","guestPath":"/workspace","createMs":47},"sessionId":"…","timestamp":"…"}
```

If `--sandbox none` (the default), the same line is still emitted with
`backend: "none"` so downstream consumers always know which mode the run
used.

## When to use this

- You have an orchestrator that calls a coding agent once per workflow
  phase, in a container, and parses a JSONL stream.
- You used to call `opencode run --format json` and want a less-opaque
  replacement built on a more hackable substrate.
- You need GitHub repo operations available to the agent without standing
  up an MCP server.

## When **not** to use this

- You want a chat UI or a long-running agent. Use [`pi`](https://github.com/earendil-works/pi)
  directly — its interactive and RPC modes are excellent.
- You want generic MCP support. Pi has none by design and agentic-pi inherits
  that decision; only the GitHub tool surface is built-in.
- You want a different tool surface (Linear, GitLab, internal APIs). Fork the
  `extensions/github/` directory as a template, not as a runtime plugin
  system — agentic-pi does not (yet) load arbitrary external extensions.

## Usage

```bash
echo "list open PRs on owner/repo" | agentic-pi run \
  --model anthropic/claude-haiku-4-5 \
  --profile read \
  --no-session
```

Required env (one of):

```bash
# Anthropic/OpenAI/OpenRouter — at least one matching your --model
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_API_KEY=sk-…
OPENROUTER_API_KEY=sk-or-…

# GitHub — App credentials preferred over static token
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/abs/path/app.pem
GITHUB_APP_INSTALLATION_ID=…
# or, for low-trust fallback:
GITHUB_TOKEN=ghp_…
```

## Flags

| Flag | Description |
| --- | --- |
| `--model <provider/id>` | Required. e.g. `anthropic/claude-opus-4-5`, `openai/gpt-4o`. |
| `--thinking <level>` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `--variant <level>` | Alias for `--thinking`. |
| `--profile <name>` | `read` \| `issues-write` \| `review-write` \| `repo-write`. Omit to disable GitHub tools entirely. |
| `--cwd <path>` | Working directory for the agent. Default: `$PWD`. |
| `--no-session` | Ephemeral run — do not persist session jsonl. Recommended in sandboxed containers. |
| `--session-dir <path>` | Override session storage location. |
| `--no-builtin-tools` | Disable Pi's `read,write,edit,bash,grep,find,ls`. |
| `--tools <a,b,c>` | Explicit tool allowlist (combined with profile if set). |
| `--sandbox <none\|gondolin>` | Route `read`/`write`/`edit`/`bash` through a sandbox backend. Default `none`. `gondolin` boots a QEMU micro-VM mounting cwd at `/workspace`. Requires QEMU on the host; native-only (not Docker-in-Docker). See section 8. |
| `--dangerously-skip-permissions` | Accepted for caller-side compatibility. No-op. |

Reads the prompt from stdin. Emits JSONL on stdout. Exits 0 on `agent_end`,
1 on fatal error.

## Event stream

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}
{"type":"sandbox_status","backend":"none","status":{"backend":"none"},"sessionId":"<uuid>","timestamp":"…"}
{"type":"extension_status","extension":"github","status":"configured","profile":"read","toolCount":18,"sessionId":"<uuid>","timestamp":"…"}
{"type":"agent_start","sessionId":"<uuid>","timestamp":"…"}
{"type":"turn_start","sessionId":"<uuid>","timestamp":"…"}
{"type":"message_start","message":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"},"sessionId":"<uuid>","timestamp":"…"}
{"type":"tool_execution_start","toolCallId":"…","toolName":"github_list_pull_requests","args":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"tool_execution_end","toolCallId":"…","toolName":"github_list_pull_requests","result":{"content":[…]},"isError":false,"sessionId":"<uuid>","timestamp":"…"}
{"type":"message_end","message":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"turn_end","message":{…},"toolResults":[…],"sessionId":"<uuid>","timestamp":"…"}
{"type":"agent_end","messages":[…],"willRetry":false,"sessionId":"<uuid>","timestamp":"…"}
{"type":"usage_snapshot","stats":{"userMessages":1,"assistantMessages":2,"toolCalls":1,"toolResults":1,"tokens":{"input":…,"output":…,"cacheRead":…,"cacheWrite":…,"total":…},"cost":0.000…},"sessionId":"<uuid>","timestamp":"…"}
```

`extension_status` is emitted once at startup so downstream logs can confirm
the GitHub profile (and whether auth succeeded). `usage_snapshot` is always
the last line in a successful run.

## Programmatic usage

If your orchestrator runs Node, you can skip the subprocess and import
agentic-pi directly. The `run()` API never touches `process.stdout` or
`process.stderr` — it returns a fully-derived `RunResult` and forwards
events through callbacks instead.

```ts
import { run } from "agentic-pi";

const result = await run({
  model: "anthropic/claude-haiku-4-5",
  prompt: "list the open PRs on owner/repo and summarize them",
  thinking: "medium",
  profile: "read",
  sandbox: "none",
  noSession: true,
  cwd: "/path/to/workspace",

  // Optional observability hooks. Both are pure callbacks — no I/O happens
  // unless you do something with the values.
  onEvent: (record) => myShim.writeJsonl(record),
  onWarn: (msg) => myLogger.warn(msg),
});

if (!result.ok) {
  throw new Error(result.fatalError?.message ?? "agent failed");
}

console.log(result.finalText);           // "There are 3 open PRs: …"
console.log(result.sessionId);           // Pi session UUID
console.log(result.stats?.tokens.total); // total tokens
console.log(result.stats?.cost);         // USD
console.log(result.sandbox?.backend);    // "none" | "gondolin"
console.log(result.github?.status);      // "configured" | "skipped"
console.log(result.records.length);      // full event log
```

### `RunResult` shape

| Field | Type | Description |
| --- | --- | --- |
| `exitCode` | `0 \| 1 \| 2` | Same code the CLI would have returned. |
| `ok` | `boolean` | `exitCode === 0`. |
| `agentEnded` | `boolean` | Pi emitted `agent_end`. |
| `toolErrors` | `boolean` | At least one tool returned an error. |
| `fatalError` | `{name, message}` \| `undefined` | Set if a fatal error short-circuited the run. |
| `sessionId` | `string` \| `undefined` | Pi session UUID. |
| `cwd` | `string` \| `undefined` | Working directory the agent ran in. |
| `startedAt` | `string` \| `undefined` | ISO timestamp of session start. |
| `finalText` | `string` | Concatenated last-assistant text content. |
| `messages` | `unknown[]` | Full Pi message array from `agent_end`. |
| `stats` | `{userMessages, assistantMessages, toolCalls, toolResults, tokens: {input, output, cacheRead, cacheWrite, total}, cost}` \| `undefined` | Token + cost rollup. |
| `sandbox` | `{backend, status}` \| `undefined` | Mirror of the `sandbox_status` event. |
| `github` | `{status, reason, profile, toolCount}` \| `undefined` | Mirror of the `extension_status` event. |
| `records` | `EmitterRecord[]` | Every JSONL record in order. Same shape that the CLI writes. |
| `warnings` | `string[]` | Warnings that would have gone to stderr in CLI mode. |

### When to use which API

| If you want… | Use |
| --- | --- |
| The same observable stream the CLI produces, captured to a file or proxied to a UI | `run({ ..., onEvent })` |
| A single object describing the outcome (lastlight's `ExecutionResult` mapping) | `run()` and read `result.finalText`/`result.stats` |
| Direct control over the sink (e.g. write straight to a writable stream you already have) | `run({ ..., extraSink })` or drop down to `runOnce(config, prompt, { sink, onWarn })` |
| Cancellation | Not supported yet — kill the host process. Open an issue if you need this. |

### Notes for in-process callers

- agentic-pi reuses the host process's env vars (`OPENAI_API_KEY`,
  `GITHUB_APP_ID`, …). If your orchestrator runs multiple
  workflows with different credentials, `process.env` is the seam to vary.
- `cwd` is per-call; you can run multiple agents in parallel against
  different working directories from the same orchestrator process.
- Sessions are created fresh each call. Pass `noSession: true` if you
  don't want session JSONLs accumulating under `~/.pi/agent/sessions/`.
- The sandbox boots and tears down per call. If you're processing many
  short tasks against the same workspace, the per-task VM cost adds up;
  consider batching or just leaving `sandbox: "none"`.

## Development

```bash
npm install
npm run build
echo "hello" | node dist/cli.js run --model anthropic/claude-haiku-4-5 --no-session
```

Project layout:

```
src/
  cli.ts                       argv → run config; reads stdin; wraps run()
  index.ts                     public library API: run, RunResult, sinks
  run.ts                       programmatic entry: in-process run() + result accumulation
  args.ts                      flag parser
  stdin.ts                     stdin slurp
  runner.ts                    createAgentSession → subscribe → prompt → emit
  emitter.ts                   sink abstraction (Stdout / Collector / Tee) + Emitter
  models.ts                    "provider/id" → getModel(...)
  extensions/github/
    index.ts                   loadGitHubExtension(profile) entry
    auth.ts                    GitHubAppAuth (JWT → installation token) + static fallback
    client.ts                  Octokit wrapper with retry/backoff
    credentials.ts             git credential-store file writer (mode 600)
    profiles.ts                4 profiles → tool name allowlists
    tools.ts                   31 defineTool() registrations
  sandbox/
    index.ts                   buildSandbox(backend) dispatcher
    preflight.ts               QEMU + accelerator detection (refuses to start if hung)
    gondolin.ts                VM lifecycle + tool overrides for read/write/edit/bash
test/fixtures/                 golden JSONL streams from real runs
SPIKE-gondolin.md              spike notes on why sandbox is native-only
```

## Status & relationship to Pi

agentic-pi pins to `@earendil-works/pi-coding-agent ^0.75.4`. It uses Pi's SDK
in-process (`createAgentSession`, `session.subscribe`, `session.prompt`,
`session.getSessionStats`) — not the CLI subprocess. If Pi's SDK changes shape,
agentic-pi will need to track it; that's the trade-off taken for in-process
speed and direct access to session state.

It does **not** wrap, fork, or modify Pi. Pi's defaults that we don't
override remain in effect: AGENTS.md auto-discovery, ~/.pi/agent skills /
extensions / prompts / themes, the same model registry, the same auth
storage. If you `pi /login` and authenticate via subscription, agentic-pi
will pick that up too.
