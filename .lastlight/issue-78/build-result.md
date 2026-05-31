# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/cli.ts, src/utils/hello.test.ts, src/utils/hello.ts

## Code diff
```diff
diff --git a/src/cli.ts b/src/cli.ts
index fe9abe6..b64696a 100644
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -38,6 +38,7 @@ Usage:
   tsx src/cli.ts health <owner/repo>   Generate weekly health report
   tsx src/cli.ts build <github-url>    Run FULL build cycle (architect/executor/reviewer/PR)
   tsx src/cli.ts build <owner/repo#N>  Same, shorthand
+  tsx src/cli.ts hello <name>          Print a simple greeting (Hello <name>!)
 
 The default for a single issue reference is now TRIAGE, not build.
 Build cycles are expensive — opt in explicitly with the \`build\` subcommand.
@@ -84,6 +85,18 @@ async function main() {
     process.exit(0);
   }
 
+  // Simple hello subcommand — prints a greeting and exits (no server needed)
+  if (args[0] === "hello") {
+    const { hello } = await import("./utils/hello.js");
+    const name = args[1];
+    if (!name) {
+      console.error("Usage: tsx src/cli.ts hello <name>");
+      process.exit(1);
+    }
+    hello(name);
+    process.exit(0);
+  }
+
   // Check server is running
   try {
     const healthRes = await fetch(`${SERVER_URL}/health`);
diff --git a/src/utils/hello.test.ts b/src/utils/hello.test.ts
new file mode 100644
index 0000000..4cbbdb9
--- /dev/null
+++ b/src/utils/hello.test.ts
@@ -0,0 +1,20 @@
+import { describe, expect, it, vi, afterEach } from "vitest";
+import { hello } from "./hello.js";
+
+afterEach(() => {
+  vi.restoreAllMocks();
+});
+
+describe("hello", () => {
+  it("prints a greeting for Alice", () => {
+    const spy = vi.spyOn(console, "log");
+    hello("Alice");
+    expect(spy).toHaveBeenCalledWith("Hello Alice!");
+  });
+
+  it("prints a greeting for Bob", () => {
+    const spy = vi.spyOn(console, "log");
+    hello("Bob");
+    expect(spy).toHaveBeenCalledWith("Hello Bob!");
+  });
+});
diff --git a/src/utils/hello.ts b/src/utils/hello.ts
new file mode 100644
index 0000000..406acbe
--- /dev/null
+++ b/src/utils/hello.ts
@@ -0,0 +1,3 @@
+export function hello(name: string): void {
+  console.log(`Hello ${name}!`);
+}

```