# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/util/hello.test.ts, src/util/hello.ts

## Code diff
```diff
diff --git a/src/util/hello.test.ts b/src/util/hello.test.ts
new file mode 100644
index 0000000..473289e
--- /dev/null
+++ b/src/util/hello.test.ts
@@ -0,0 +1,24 @@
+import { afterEach, describe, expect, it, vi } from "vitest";
+import { sayHello } from "./hello.js";
+
+describe("sayHello", () => {
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("prints 'Hello <name>!' to stdout", () => {
+    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
+
+    sayHello("World");
+
+    expect(logSpy).toHaveBeenCalledWith("Hello World!");
+  });
+
+  it("handles empty name without throwing", () => {
+    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
+
+    sayHello("");
+
+    expect(logSpy).toHaveBeenCalledWith("Hello !");
+  });
+});
diff --git a/src/util/hello.ts b/src/util/hello.ts
new file mode 100644
index 0000000..fbf77d3
--- /dev/null
+++ b/src/util/hello.ts
@@ -0,0 +1,5 @@
+export function sayHello(name: string): void {
+  // Minimal implementation per issue #78: no trimming or fallback, just literal interpolation.
+  // Callers are responsible for passing a suitable name.
+  console.log(`Hello ${name}!`);
+}

```