# Executor summary

Changes implemented:

1. New utility function

- Added `src/util/hello.ts`:

```ts
export function sayHello(name: string): void {
  // Minimal implementation per issue #78: no trimming or fallback, just literal interpolation.
  // Callers are responsible for passing a suitable name.
  console.log(`Hello ${name}!`);
}
```

2. Tests

- Added `src/util/hello.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sayHello } from "./hello.js";

describe("sayHello", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints 'Hello <name>!' to stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sayHello("World");

    expect(logSpy).toHaveBeenCalledWith("Hello World!");
  });

  it("handles empty name without throwing", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sayHello("");

    expect(logSpy).toHaveBeenCalledWith("Hello !");
  });
});
```

- Note: the import uses `./hello.js` to satisfy the `Node16` module resolution requirements for test compilation.

3. Guardrail commands run

- Tests:

  - Command: `npm test`
  - Result: All tests passed.

    - `Test Files  28 passed (28)`
    - `Tests  469 passed | 1 todo (470)`

- Build / typecheck:

  - Command: `npm run build`
  - Result: Completed successfully (`tsc` exits with no errors) after updating the test import to `./hello.js`.
