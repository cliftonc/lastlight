# Architect Plan — Issue #98

## Problem Statement

The Claude-SDK-style session envelope format is currently parsed directly by `unwrapLine` in `src/admin/sessions.ts:62-202`, while sandbox metadata and message reads call it from separate loops in `src/admin/sessions.ts:355-434` and `src/admin/sessions.ts:498-519`. The same format parser is imported again by chat reads in `src/admin/chat-session-reader.ts:1-115` and by live SSE streaming in `src/admin/routes.ts:7` and `src/admin/routes.ts:230-247`. On-disk path knowledge is also duplicated: `SessionReader` scans `<home>/projects/*/<id>.jsonl` in `src/admin/sessions.ts:243-264`, `ChatSessionReader` reconstructs `<home>/projects/-app/<agentSessionId>.jsonl` in `src/admin/chat-session-reader.ts:75-85`, and `AgenticShim` writes by manually joining the same tree in `src/engine/event-shim.ts:162-173`, `src/engine/event-shim.ts:211-220`, and `src/engine/event-shim.ts:385-397`.

## Summary of what needs to change

Introduce a central `SessionLog` module that owns:

- envelope append/write serialization;
- JSONL line parsing and normalization (the current `unwrapLine` behavior becomes private implementation);
- session file path resolution, project slug generation, scope filtering (`sandbox` vs `chat`), and agent sub-session file discovery.

Then refactor the shim and dashboard readers/routes to delegate all session-log format/path operations to `SessionLog`, while keeping existing dashboard API behavior and tests intact.

## Files to modify — exhaustive manifest

### New source module

1. `src/session-log.ts` — new module, single authority for JSONL envelope storage.
   - Add exported constants/types:
     - `CHAT_PROJECT_SLUG = "-app"`.
     - `type SessionLogScope = "sandbox" | "chat"` (move/replace `SessionReaderScope` from `src/admin/sessions.ts:215`).
     - `interface JsonlMessage` (move from `src/admin/sessions.ts:9-19`, or export here and re-export from `sessions.ts` for compatibility).
     - `interface SessionLogRef { projectSlug: string; sessionId: string }`.
     - `interface SessionLogEntry { id: string; filePath: string; mtimeMs: number; projectSlug: string }`.
     - `interface NormalizedLogRecord { timestamp: string; msg: JsonlMessage; raw: Record<string, unknown> }` if useful for readers.
   - Add `export function projectSlugForCwd(cwd: string): string`, moved from `src/engine/event-shim.ts:469-476`.
   - Add `export class SessionLog` with at least these public methods (names can vary, but keep these responsibilities centralized):
     - `constructor(homeDir: string)`.
     - `normalizeSessionId(sessionId: string): string | null` — validates basename and `^[A-Za-z0-9_-]+$`; used by the shim fallback instead of duplicating validation.
     - `pathForProject(projectSlug: string, sessionId: string, opts?: { requireExists?: boolean }): string | null` — the only implementation of `<home>/projects/<slug>/<id>.jsonl`.
     - `findSession(scope: SessionLogScope, sessionId: string): SessionLogEntry | null` — replaces `SessionReader.pathFor`.
     - `listSessions(scope: SessionLogScope): SessionLogEntry[]` — replaces `SessionReader.projectDirs` + list loop and preserves newest-first-by-mtime sorting and `agent-*` filtering.
     - `relatedFilesForSession(scope: SessionLogScope, sessionId: string, opts?: { includeAgents?: boolean }): string[]` — returns main file plus same-dir `agent-*.jsonl` and `<dir>/<sessionId>/subagents/agent-*.jsonl` when `includeAgents` is true; replaces duplicated agent file discovery in `src/admin/sessions.ts:328-341` and `src/admin/sessions.ts:482-490`.
     - `appendEnvelopeLines(ref: SessionLogRef, lines: object[]): Promise<void>` — JSON-stringifies, mkdirs the project directory, and appends newline-terminated JSONL; replaces `AgenticShim.appendLines` filesystem writes.
     - `readNormalizedFile(filePath: string, opts?: { skipEmptySystem?: boolean }): Promise<Array<{ timestamp: string; msg: JsonlMessage; raw: Record<string, unknown> }>>`.
     - `readNormalizedSession(scope: SessionLogScope, sessionId: string, opts?: { includeAgents?: boolean; skipEmptySystem?: boolean }): Promise<Array<{ index: number; msg: JsonlMessage }>>`.
     - `normalizeLine(raw: Record<string, unknown>): JsonlMessage[]` — public delegate for route tailing, but the actual unwrap implementation should be a private helper in this module.
   - Move current `unwrapLine` logic from `src/admin/sessions.ts:62-202` into a private function inside this module. Preserve all variants:
     - role-based/legacy input (`raw.role`) returns one normalized message;
     - `type: "user"` with `tool_result` content emits one `role: "tool"` per block;
     - `type: "assistant"` maps text/tool_use/reasoning and API errors;
     - `type: "tool_result"` and `type: "tool_use"` map to normalized tool/assistant messages;
     - skip `queue-operation`, `summary`, `login`, `last-prompt`, and `attachment`.

### Admin dashboard session reader files

2. `src/admin/sessions.ts`
   - Lines `1-3`: remove `path` and `readline` imports after file/path/readline operations move to `SessionLog`; retain `fs` only if still needed for the mtime fallback, or use `SessionLog` helpers to avoid direct path statting.
   - Lines `9-19`: remove local `JsonlMessage` definition; import and re-export `type JsonlMessage` from `../session-log.js` so downstream imports from `./sessions.js` continue to typecheck.
   - Lines `62-202`: delete exported `unwrapLine`; no standalone unwrap function may remain outside `SessionLog`.
   - Line `215`: replace `SessionReaderScope` with imported/re-exported `SessionLogScope` (or alias `export type SessionReaderScope = SessionLogScope` if preserving external type names helps).
   - Lines `224-230`: add `normalizeRawLine(raw: Record<string, unknown>): JsonlMessage[]` to `SessionSource` so routes can normalize tailed records through the reader’s `SessionLog` instead of importing `unwrapLine`.
   - Lines `232-241`: change `SessionReader` to store `private sessionLog: SessionLog` and `private scope: SessionLogScope`. Constructor should accept either `(sessionsHomeDir: string, scope)` and internally instantiate `new SessionLog(sessionsHomeDir)`, or preferably `(sessionLog: SessionLog, scope)` with backwards-compatible overload if desired.
   - Lines `243-264`: remove `projectDirs()` and `pathFor()` implementations; replace with `this.sessionLog.findSession(this.scope, sessionId)` / `this.sessionLog.pathFor...` calls.
   - Lines `286-308`: replace manual directory scanning with `this.sessionLog.listSessions(this.scope).map((e) => e.id)` while preserving order and `agent-*` filtering.
   - Lines `324-341`: replace direct `path.dirname`, `fs.readdirSync`, and subagent path construction with `const entry = this.sessionLog.findSession(...)` and `this.sessionLog.relatedFilesForSession(this.scope, sessionId, { includeAgents: true })`.
   - Lines `355-434`: replace manual read/JSON parse/`unwrapLine` loop with `SessionLog.readNormalizedFile(...)` or an async iterator from `SessionLog`; keep existing metadata aggregation logic exactly the same.
   - Lines `437-447`: mtime fallback should use the `SessionLogEntry.mtimeMs` from `findSession`, or a `SessionLog.statFile` helper, rather than rebuilding paths.
   - Lines `472-519`: replace `readFile` and agent-file discovery with `this.sessionLog.readNormalizedSession(this.scope, sessionId, { includeAgents: true, skipEmptySystem: true })` or equivalent; preserve timestamp sorting and index assignment.
   - Lines `521-524`: implement `getFilePath` by delegating to `SessionLog.findSession`/`pathForProject`; no manual path construction.
   - Add `normalizeRawLine(raw)` implementation delegating to `this.sessionLog.normalizeLine(raw)`.

3. `src/admin/chat-session-reader.ts`
   - Lines `1-6`: remove `fs`, `path`, `readline`, and `unwrapLine` imports; import `SessionLog`, `CHAT_PROJECT_SLUG`, and `type JsonlMessage` from `../session-log.js`; keep `SessionSource`/`SessionMeta` from `./sessions.js` if still exported there.
   - Lines `22-28`: replace `sessionsHomeDir` storage with `private sessionLog: SessionLog`; constructor should accept `(db: StateDb, sessionLog: SessionLog)` or retain `(db, sessionsHomeDir)` and instantiate internally. Prefer passing a shared `SessionLog` from `src/admin/index.ts`.
   - Lines `75-85`: remove manual `path.join(..., "projects", "-app", ...)` and `fs.existsSync`; resolve with `this.sessionLog.pathForProject(CHAT_PROJECT_SLUG, thread.agentSessionId, { requireExists: true })`.
   - Lines `94-114`: delete `readSingleFile`; implement `read(id)` via `this.sessionLog.readNormalizedSession("chat", agentSessionId, { includeAgents: false, skipEmptySystem: true })` or `readNormalizedFile(getFilePath(...))`.
   - Add `normalizeRawLine(raw)` implementation delegating to `this.sessionLog.normalizeLine(raw)` for `SessionSource`.
   - Update comments at lines `16-19` to avoid hardcoding path construction; refer to `SessionLog` resolving `CHAT_PROJECT_SLUG`.

4. `src/admin/routes.ts`
   - Line `7`: remove `unwrapLine` import; import only `type SessionSource, type SessionMeta` from `./sessions.js`.
   - Lines `230-247`: in the live stream callback, replace `unwrapLine(msg as Record<string, unknown>)` with `sessions.normalizeRawLine(msg as Record<string, unknown>)`. This keeps route streaming format-agnostic and routes all parsing through `SessionLog`.
   - No other route behavior should change.

5. `src/admin/index.ts`
   - Lines `3-6`: import `SessionLog` from `../session-log.js`.
   - Lines `14-20`: instantiate one shared `const sessionLog = new SessionLog(config.sessionsDir);`, then pass it to `new SessionReader(sessionLog, "sandbox")` and `new ChatSessionReader(db, sessionLog)`.

### Engine shim and callers

6. `src/engine/event-shim.ts`
   - Lines `1-2`: remove `fs/promises` and `path` imports; import `SessionLog` from `../session-log.js`.
   - Lines `28-36`: keep `AgenticShimOptions` shape for callers, but note `projectSlug` is interpreted by `SessionLog`.
   - Lines `58-68`: replace `private filePath: string | null` with `private sessionLog: SessionLog` and `private sessionId: string | null`; keep `writeChain`.
   - Lines `70-76`: initialize `this.sessionLog = new SessionLog(opts.homeDir)`; `isInitialized` should return `this.sessionId !== null`.
   - Lines `90-97`: replace `openFile` calls/checks with an `openSession(sessionId)` helper that delegates id validation to `SessionLog.normalizeSessionId` and stores the safe id.
   - Lines `121-148`: replace `path.basename(this.filePath, ".jsonl")` with `this.sessionId` and append through `SessionLog`.
   - Lines `162-204`: remove fallback manual basename/regex/path join; call `openSession(fallbackSessionId)`, write bootstrap/final envelopes through `SessionLog`, and return the normalized session id.
   - Lines `211-220`: replace `openFile` with `openSession`; no path joining in the shim.
   - Lines `385-397`: replace direct JSONL serialization/mkdir/appendFile with `this.sessionLog.appendEnvelopeLines({ projectSlug: this.opts.projectSlug, sessionId: this.sessionId }, lines)` inside the existing `writeChain` and warning handler.
   - Lines `469-476`: remove `projectSlugForCwd` export from this file; it moves to `src/session-log.ts`.
   - Preserve event translation methods (`translateMessageEnd`, `translateToolEnd`, etc.) and utility exports `safeStringify` / `truncateForLog`.

7. `src/engine/agent-executor.ts`
   - Line `20`: change imports so `AgenticShim`, `truncateForLog`, and `safeStringify` still come from `./event-shim.js`, but `projectSlugForCwd` comes from `../session-log.js`.
   - Lines `299-304` and `526-531`: continue passing `projectSlug: projectSlugForCwd(agentCwd)` to `AgenticShim`; no behavioral change.

8. `src/engine/chat.ts`
   - Line `6`: keep `AgenticShim` import.
   - Add import of `CHAT_PROJECT_SLUG` from `../session-log.js`.
   - Lines `225-229` and `301-304`: replace hardcoded `projectSlug: "-app"` with `projectSlug: CHAT_PROJECT_SLUG`; update the line `// ChatSessionReader hardcodes this slug` to say the slug is centralized in `SessionLog`.

### Tests

9. `src/session-log.test.ts` — new unit test file for acceptance criteria.
   - Test `SessionLog.appendEnvelopeLines` + `readNormalizedSession` round-trip:
     - write a user envelope `{ type: "user", message: { role: "user", content: "hello" }, timestamp, sessionId }`;
     - write an assistant envelope with text and tool_use blocks;
     - write a user envelope containing a `tool_result` block;
     - read back normalized records and assert roles/content/tool_calls/tool_call_id/timestamps.
   - Test legacy/role-based variant currently handled by `unwrapLine`:
     - append `{ role: "assistant", content: "legacy assistant", timestamp }` and assert it reads back as the same normalized message.
   - Test path ownership enough to prevent regressions:
     - `projectSlugForCwd("/home/agent/workspace")` returns `"-home-agent-workspace"`;
     - `pathForProject(projectSlug, "sess1", { requireExists: false })` points under `<tmp>/projects/<projectSlug>/sess1.jsonl`;
     - invalid ids such as `"../bad"` or `"bad.jsonl"` return `null` from `normalizeSessionId`/path resolution.
   - Use `fs.mkdtemp`/`fs.rm` cleanup pattern like `src/engine/event-shim.test.ts:7-13`.

10. `src/admin/sessions.test.ts`
   - Existing tests at lines `16-89` should remain and pass unchanged.
   - If constructor signature changes without overload compatibility, update instantiations at lines `45`, `56`, `72`, and `84` to create/pass `new SessionLog(home)`.
   - Do not remove the current ordering, mtime fallback, or `-app` exclusion coverage; these are dashboard behavior regressions relevant to the refactor.

11. `src/admin/routes.test.ts`
   - Lines `52-58`: add `normalizeRawLine: vi.fn((raw: Record<string, unknown>) => [raw])` (or a minimal normalized result if stream tests are added) to `mockSessions` so the expanded `SessionSource` interface typechecks.
   - Lines `634-640`: ensure `appWith` mock inherits or supplies `normalizeRawLine` after the interface change.
   - No existing route assertions should need semantic changes.

12. `src/engine/event-shim.test.ts`
   - Line `5`: import `projectSlugForCwd` and `SessionLog` from `../session-log.js`; import only `AgenticShim` from `./event-shim.js`.
   - Lines `15-26`: compute expected file path through `SessionLog.pathForProject(projectSlug, "sess1", { requireExists: false })` rather than duplicating `path.join(homeDir, "projects", projectSlug, "sess1.jsonl")`.
   - Existing assertions at lines `37-114` should remain behaviorally unchanged.

### No code changes expected outside this set

All files in the touched multi-file groups have been enumerated:

- Admin session group under `src/admin/`: `src/admin/sessions.ts`, `src/admin/chat-session-reader.ts`, `src/admin/routes.ts`, `src/admin/index.ts`, `src/admin/sessions.test.ts`, `src/admin/routes.test.ts`.
- Engine shim/caller group under `src/engine/`: `src/engine/event-shim.ts`, `src/engine/event-shim.test.ts`, `src/engine/agent-executor.ts`, `src/engine/chat.ts`.
- New central module/tests: `src/session-log.ts`, `src/session-log.test.ts`.

Do not change dashboard React files; the API shape and normalized message shape should remain identical.

## Commands

Copied from `.lastlight/issue-98/guardrails-report.md` and CI:

```bash
npm ci
npx tsc --noEmit
npx tsc -b dashboard
npx vitest run
```

Notes from guardrails:

- Local `npm run test` failed in the guardrails environment because devDependencies were not installed (`vitest: not found`).
- CI installs dependencies with `npm ci` and then runs the typecheck/test commands above.
- No hard lint command is configured.

## Implementation approach

1. Create `src/session-log.ts` and move the envelope parser (`unwrapLine`) plus project slug/path helpers into it. Keep `unwrapLine` private; expose `SessionLog.normalizeLine` as the only parsing entry point.
2. Implement `SessionLog` filesystem methods for path resolution, project-scope listing, append writes, normalized file reads, normalized session reads, and agent sub-session discovery. Preserve existing quirks: `-app` excluded from sandbox scope, `agent-*` hidden from top-level lists, unreadable/malformed lines skipped, and newline-terminated appends.
3. Refactor `AgenticShim` to store only a safe `sessionId` and call `SessionLog.appendEnvelopeLines`. Remove all manual path joins and mkdir/append logic from the shim.
4. Update engine callers to import `projectSlugForCwd`/`CHAT_PROJECT_SLUG` from `SessionLog` instead of `event-shim` or hardcoding `-app`.
5. Refactor `SessionReader` to delegate list/path/read/normalize behavior to a `SessionLog` instance, retaining only dashboard metadata aggregation and session-type detection.
6. Refactor `ChatSessionReader` to use the DB only for thread → agent session id lookup; all file path resolution and normalized reads should go through `SessionLog`.
7. Refactor `mountSessionRoutes` streaming to call `sessions.normalizeRawLine(...)`, so route code no longer knows the envelope format.
8. Add `src/session-log.test.ts` round-trip and legacy-format tests, then update affected existing tests/mocks/imports.
9. Run the guardrail commands. If dependencies are missing locally, run `npm ci` first as listed.

## Risks and edge cases

- Live stream indexing currently uses raw JSONL line positions from `tailJsonl`, then increments per normalized message; a raw line that normalizes to multiple tool messages can shift IDs. Preserve the existing route behavior when changing only the parser call site.
- `ChatSessionReader.exists(id)` intentionally checks DB thread existence, not file existence; keep that behavior so pre-resume/missing-file threads still produce the same responses as today.
- `SessionReader.getSessionMeta` scans main + agent sub-session files and must compute true min/max timestamps across files; do not regress to scan-order-dependent timestamps.
- Empty/timestamp-less files must still use file mtime for `started_at` instead of `Date.now()`.
- Invalid session ids must not create/write outside `<home>/projects/<slug>`; keep the current basename + regex protection centralized in `SessionLog`.
- The legacy role-based format (`{ role: ... }`) is still consumed by existing session logs; removing it would break old dashboard sessions.

## Test strategy

- New focused unit tests in `src/session-log.test.ts` prove write/read round-trip, tool-result fan-out, legacy role-based normalization, and path/id validation.
- Existing `src/admin/sessions.test.ts` verifies dashboard session list ordering, mtime fallback, and sandbox/chat scope filtering after the reader delegates to `SessionLog`.
- Existing `src/engine/event-shim.test.ts` verifies the shim still writes the same envelope shapes, now through `SessionLog`.
- Full regression via `npx vitest run`, plus `npx tsc --noEmit` and `npx tsc -b dashboard` for interface/import changes.

## Estimated complexity

Medium.
