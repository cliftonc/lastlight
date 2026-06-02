### Problem Statement

Issue [#78](https://github.com/cliftonc/lastlight/issues/78) requests a small, reusable function that accepts a `name` and prints `Hello ${name}!`. The repo already has utilities and tests around string handling and logging, but there is no dedicated, exported “hello world” helper surfaced as part of the harness/CLI. The goal is to add a minimal, idiomatic helper consistent with the existing TypeScript structure and test suite so it can be reused in future features.

### Summary of what needs to change

- Introduce a small TypeScript utility function, e.g. `sayHello(name: string): void`, that prints `Hello ${name}!` to stdout.
- Export this helper from a reasonable module so it can be reused (likely under `src/` as a small utility, or integrated into the CLI if preferred).
- Add unit tests validating the exact printed output and behavior for simple edge cases.
- Optionally (if desired by the maintainers), wire the helper into an existing CLI or dev-only code path to demonstrate usage, without impacting production behavior.

### Files to modify

1. **New file:** `src/util/hello.ts` (or similar)
   - Define and export a reusable function:
     - Signature: `export function sayHello(name: string): void`.
     - Behavior: prints exactly `Hello ${name}!` followed by a newline to `console.log`.
   - Keep implementation dependency-free and side-effect-limited (only logging).

2. **New test file:** `src/util/hello.test.ts`
   - Add Vitest tests (Vitest is already used across the repo, e.g. `src/engine/llm.test.ts:98-107`, `src/workflows/templates.test.ts:19-25`):
     - Verify that calling `sayHello("World")` logs `Hello World!`.
     - Verify that trimming or handling of empty names matches the chosen behavior (see implementation approach).
   - Use the standard pattern in the repo: `describe`, `it`, and `vi.spyOn(console, "log")` or similar to capture output.

3. **Optional (if maintainers want a CLI hook):** `src/cli.ts`
   - Add a minimal, non-breaking optional code path to call `sayHello` (e.g. a `--hello <name>` dev/demo flag).
   - Keep behavior fully backward-compatible so existing CLI usage is unaffected.

4. **Optionally update docs:** `README.md`
   - Small snippet under a “Examples” or “Development helpers” section illustrating `sayHello` usage, if it’s intended for public consumption.

### Implementation approach

1. **Decide module location and API**
   - Create `src/util/` if it doesn’t already exist; place `hello.ts` there to avoid overloading core engine files (the core layout is described in `CLAUDE.md:51-70`).
   - API:
     ```ts
     export function sayHello(name: string): void;
     ```
   - This keeps it simple, synchronous, and easy to call from anywhere (or from the CLI).

2. **Implement the function**

   In `src/util/hello.ts`:

   - Normalize `name` minimally:
     - Convert `name` to string (in case callers pass non-string accidentally).
     - Optionally trim whitespace: `const safeName = String(name).trim();`.
   - Decide behavior for empty or whitespace-only names:
     - Option A: allow `Hello !` (literal) — simplest and matches the literal issue text.
     - Option B: use a fallback like `world` or `"friend"` if trimmed name is empty.
   - For minimalism and to stay closest to the issue wording, pick **Option A** unless there’s a strong preference otherwise:
     ```ts
     export function sayHello(name: string): void {
       console.log(`Hello ${name}!`);
     }
     ```
   - Avoid side effects other than the log; no process exit, no I/O beyond stdout.

3. **Add tests**

   In `src/util/hello.test.ts`:

   - Import the helper and set up Vitest:

     ```ts
     import { describe, it, expect, vi, afterEach } from "vitest";
     import { sayHello } from "./hello";
     ```

   - Spy on `console.log`:

     ```ts
     const logSpy = vi.spyOn(console, "log").mockImplementation(() => { /* no-op */ });

     // After each test, restore mocks
     afterEach(() => {
       vi.restoreAllMocks();
     });
     ```

   - Write tests:

     - Basic behavior:

       ```ts
       it("prints Hello <name>! to stdout", () => {
         sayHello("World");
         expect(logSpy).toHaveBeenCalledWith("Hello World!");
       });
       ```

     - Edge case(s) as per chosen behavior:

       - If we don’t trim: test direct passthrough.
       - If we do trim: test `"  World  "` gives `"Hello World!"`.
       - For empty strings, just assert the exact literal:

       ```ts
       it("handles empty name without throwing", () => {
         sayHello("");
         expect(logSpy).toHaveBeenCalledWith("Hello !");
       });
       ```

   - Keep tests consistent with existing test style (refer to examples like `src/workflows/templates.test.ts:19-25` and `src/engine/llm.test.ts:98-107`).

4. **Optional: CLI wiring**

   If you decide to expose this via the CLI (`src/cli.ts`), without breaking existing behavior:

   - Parse arguments for a `--hello` flag and optional name, e.g.:

     ```ts
     // pseudo-code
     if (process.argv.includes("--hello")) {
       const idx = process.argv.indexOf("--hello");
       const name = process.argv[idx + 1] ?? "world";
       sayHello(name);
       process.exit(0);
     }
     ```

   - Ensure this logic runs *before* more complex CLI flows and does not interfere with existing subcommands.
   - Add a dev-note comment so maintainers know it’s just a simple demo hook.

5. **Optional: docs**

   - In `README.md`, add a tiny example if you’ve wired the CLI:

     ```md
     ```bash
     npx tsx src/cli.ts --hello "World"
     # Hello World!
     ```
     ```

   - If `sayHello` is just internal and not CLI-exposed, documentation is optional.

### Risks and edge cases

- **Behavioral expectations for empty/undefined names**:
  - The literal spec only requires `Hello ${name}!`. If `name` is `""` or `undefined`, you’ll get `Hello !` or `Hello undefined!`. The executor should choose behavior and document/test it explicitly so future callers know what to expect.
- **Accidental public API commitment**:
  - If `sayHello` is exported from a central index or used in CLI/docs, it becomes part of the de facto public API; maintainers should be comfortable keeping it stable or mark it as dev-only.
- **CLI changes (if added)**:
  - Need to ensure any `--hello` handling does not conflict with existing flags and doesn’t alter default code paths.

Overall, risk is low; the change is self-contained and easy to revert.

### Test strategy

Use the existing commands (from the guardrails report):

1. Run unit tests, including the new `hello` tests:

   ```bash
   npm test
   ```

   - Under the hood this runs `vitest run`, which already passes across existing suites (27 files, 467 tests).

2. Run a TypeScript build to ensure type correctness:

   ```bash
   npm run build
   ```

   - Under the hood this runs `tsc`, catching any TS errors in the new files.

3. If CLI changes were made, optionally smoke-test locally:

   ```bash
   npx tsx src/cli.ts --hello "World"
   ```

   - Confirm it prints `Hello World!` and exits successfully.

### Estimated complexity

- **Complexity: simple**

This is a small, self-contained utility + test addition with optional light CLI integration.