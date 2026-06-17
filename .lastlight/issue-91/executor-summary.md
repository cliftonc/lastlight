# Executor summary for issue #91

## What was done

Implemented configurable OpenTelemetry support across the harness:

- Added disabled-by-default `otel` config defaults and `LASTLIGHT_OTEL_*` env overrides.
- Added `src/telemetry/index.ts` and `src/telemetry/pi-events.ts` for OTEL SDK initialization, shutdown, span/metric/error helpers, sandbox env allowlisting, and PI event redaction/sanitization.
- Forwarded allowlisted OTEL env vars into agent executions only when telemetry is enabled and sandbox forwarding is enabled.
- Added collector-host parsing/merging for strict sandbox egress and wired docker firewall generation to include configured collector hosts.
- Instrumented agent execution, workflow phases, and chat turns with telemetry spans/metrics/events.
- Updated configuration, telemetry, PI-event, and egress tests.
- Documented OpenTelemetry configuration in `README.md`, `.env.example`, `deploy/native/lastlight.env.example`, and `CLAUDE.md`.
- Added OpenTelemetry package dependencies.

## Files changed

- `.env.example`
- `CLAUDE.md`
- `README.md`
- `config/default.yaml`
- `deploy/native/lastlight.env.example`
- `package.json`
- `package-lock.json`
- `src/config.ts`
- `src/config.test.ts`
- `src/config-overlay.test.ts`
- `src/telemetry/index.ts`
- `src/telemetry/index.test.ts`
- `src/telemetry/pi-events.ts`
- `src/telemetry/pi-events.test.ts`
- `src/engine/profiles.ts`
- `src/engine/agent-executor.ts`
- `src/engine/chat.ts`
- `src/index.ts`
- `src/workflows/runner.ts`
- `src/sandbox/egress-allowlist.ts`
- `src/sandbox/egress-allowlist.test.ts`
- `src/sandbox/egress-firewall-config.ts`
- `src/sandbox/egress-firewall-config.test.ts`

## Test results

Command: `npm test`

```text
> lastlight@0.1.15 test
> vitest run


 RUN  v4.1.7 /home/agent/workspace/lastlight

│
◆  docker-compose.override.yml → instance/docker-compose.override.yml
│
▲  docker-compose.override.yml already exists as a regular file — leaving it; not symlinking the overlay override.

 Test Files  36 passed (36)
      Tests  533 passed | 1 todo (534)
   Start at  08:56:17
   Duration  7.43s (transform 745ms, setup 0ms, import 2.06s, tests 2.11s, environment 2ms)
```

## Lint results

Command: `npm run lint`

```text
npm error Missing script: "lint"
npm error
npm error Did you mean this?
npm error   npm link # Symlink a package folder
npm error
npm error To see a list of scripts, run:
npm error   npm run
npm error A complete log of this run can be found in: /home/agent/.npm/_logs/2026-06-17T08_56_29_310Z-debug-0.log
```

No lint script is configured; this matches the architect note that lint is optional/non-blocking.

## Typecheck results

Command: `npm run build`

```text
> lastlight@0.1.15 build
> tsc
```

Command: `cd dashboard && npx tsc -b`

```text
(no output)
```

## Deviations / known issues

- `agentic-pi@^0.2.6` is not currently published to npm. `npm view agentic-pi versions --json` lists versions only through `0.2.5`, and `npm install agentic-pi@^0.2.6` failed with `ETARGET No matching version found`. I upgraded the root dependency to `agentic-pi@^0.2.5` (latest available) and documented this deviation here.
- Telemetry is intentionally metadata-only unless `LASTLIGHT_OTEL_INCLUDE_CONTENT=true`.
- OTEL header values containing newlines are not forwarded into sandboxes; this avoids breaking sandbox env handling and shell quoting.
