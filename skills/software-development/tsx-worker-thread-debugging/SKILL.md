---
name: tsx-worker-thread-debugging
description: Diagnose Node worker_threads failures when a project runs TypeScript via tsx and workers are spawned from .ts entrypoints.
version: 1.0.0
author: Sustain Bot
license: MIT
metadata:
  hermes:
    tags: [nodejs, typescript, tsx, worker-threads, vitest, debugging]
---

# tsx Worker Thread Debugging

Use this when:
- tests or local dev fail in code that spawns `worker_threads`
- the worker entrypoint is a `.ts` file
- the project relies on `tsx`/`node --import tsx` for runtime TS execution
- errors mention `Unknown file extension ".ts"` or the worker exits before doing work

## Common symptom

A higher-level feature fails with a generic compile/runtime error, but the real root cause is the worker failing to bootstrap. Typical surfaced error:

```text
Type-check worker error: Unknown file extension ".ts" for /path/to/worker.ts
```

This can make unrelated tests fail, e.g. schema/compiler tests that expect `errors.length === 0` but instead get a single worker bootstrap error.

## Investigation workflow

1. Reproduce the failing test normally.
2. Read the implementation that spawns the worker.
   - Look for `new Worker(...)`
   - Check how the worker path is chosen in dev vs prod
   - Check whether `execArgv: process.execArgv` is being used
3. Reproduce the worker failure outside the test suite with a minimal script.
   - Start the parent with `node --import tsx` or `npx tsx`
   - Spawn the same worker `.ts` file directly
   - If it still fails, the problem is worker bootstrapping, not business logic
4. Verify whether the project already builds a compiled JS worker for production.
   - Search for build scripts that emit something like `dist/typecheck-worker.js`
   - If production builds a JS worker separately, the issue is often source-mode/dev-mode only

## Key finding to remember

Passing `process.execArgv` from a `tsx` parent process is **not sufficient** to guarantee that Node worker threads can execute a `.ts` worker entrypoint.

In other words, this pattern can still fail:

```ts
new Worker('/path/to/worker.ts', {
  execArgv: process.execArgv,
})
```

Even when the parent itself was launched with tsx.

## Good evidence to collect

- Exact worker error message
- The resolved worker path (`.ts` vs `.js`)
- `process.execArgv` in the parent process
- Whether a minimal standalone worker reproduction fails the same way
- Whether a compiled JS worker exists in the build output

## Likely fix directions

Prefer one of these approaches:

### 1. Use a compiled JS worker
Best when the project already has a build step.
- Build `typecheck-worker.ts` to `dist/typecheck-worker.js`
- Point the runtime at the JS worker in environments where TS worker bootstrapping is unreliable

### 2. Add a worker bootstrap shim
- Use a tiny JS worker entrypoint that registers/loads TS support explicitly
- Then import the TS worker module from that shim

### 3. Avoid worker-based TS execution in tests
- For unit tests, optionally bypass the worker and run the check inline
- Good for test determinism, but weaker than fixing worker bootstrapping properly

## Pitfall

Do **not** assume the failing feature logic is broken just because schema/cube/compiler tests fail. If the worker never started, all higher-level assertions can be misleading.

## Minimal repro template

```bash
node --import tsx <<'EOF'
import { Worker } from 'node:worker_threads'

const worker = new Worker(new URL('./src/services/typecheck-worker.ts', import.meta.url), {
  workerData: { sourceCode: 'export const x = 1', projectRoot: process.cwd() },
  execArgv: process.execArgv,
})

worker.on('message', msg => { console.log('message', msg); process.exit(0) })
worker.on('error', err => { console.error('error', err.message); process.exit(1) })
worker.on('exit', code => { console.log('exit', code) })
EOF
```

If that produces `Unknown file extension ".ts"`, debug the worker bootstrap path first.
