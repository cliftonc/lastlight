# Build result

- final verdict: REQUEST_CHANGES
- review cycles: 3
- files changed: package-lock.json, src/index.ts, src/utils/string.test.ts, src/utils/string.ts

## Code diff
```diff
diff --git a/package-lock.json b/package-lock.json
index 3904098..011298e 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -28,7 +28,7 @@
         "zod": "^4.3.6"
       },
       "bin": {
-        "lastlight": "dist/cli.js"
+        "lastlight": "./dist/cli.js"
       },
       "devDependencies": {
         "@types/better-sqlite3": "^7.6.0",
@@ -1457,7 +1457,7 @@
         "typebox": "1.1.38"
       },
       "bin": {
-        "pi-ai": "dist/cli.js"
+        "pi-ai": "./dist/cli.js"
       },
       "engines": {
         "node": ">=22.19.0"
diff --git a/src/index.ts b/src/index.ts
index 27ab30a..f4ab2e8 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -23,6 +23,7 @@ import { runSimpleWorkflow, type SimpleWorkflowRequest } from "./workflows/simpl
 import type { RunnerCallbacks } from "./workflows/runner.js";
 import { resumeOrphanedWorkflows } from "./workflows/resume.js";
 import type { EventEnvelope } from "./connectors/types.js";
+export { truncateMiddle } from "./utils/string.js";
 
 /**
  * Pre-flight validation — checks that config is sane before starting any
diff --git a/src/utils/string.test.ts b/src/utils/string.test.ts
new file mode 100644
index 0000000..6becb84
--- /dev/null
+++ b/src/utils/string.test.ts
@@ -0,0 +1,35 @@
+import { describe, expect, it } from "vitest";
+import { truncateMiddle } from "./string";
+
+describe("truncateMiddle", () => {
+  it("returns the original string when shorter than max", () => {
+    expect(truncateMiddle("hello", 10)).toBe("hello");
+  });
+
+  it("returns the original string when length equals max", () => {
+    const text = "abcdefghij"; // length 10
+    expect(truncateMiddle(text, 10)).toBe(text);
+  });
+
+  it("truncates in the middle when text is longer than max", () => {
+    const text = "abcdefghijklmnopqrstuvwxyz";
+    const max = 10;
+    const result = truncateMiddle(text, max);
+
+    expect(result.length).toBeLessThanOrEqual(max);
+    expect(result).toContain("…");
+
+    const [start, end] = result.split("…");
+    expect(start.length).toBeGreaterThan(0);
+    expect(end.length).toBeGreaterThan(0);
+  });
+
+  it("returns empty string when max is less than or equal to 0", () => {
+    expect(truncateMiddle("hello", 0)).toBe("");
+    expect(truncateMiddle("hello", -5)).toBe("");
+  });
+
+  it("returns first character when max is 1", () => {
+    expect(truncateMiddle("hello", 1)).toBe("h");
+  });
+});
diff --git a/src/utils/string.ts b/src/utils/string.ts
new file mode 100644
index 0000000..2bbf6cb
--- /dev/null
+++ b/src/utils/string.ts
@@ -0,0 +1,24 @@
+/**
+ * Truncate a string in the middle so the result is at most `max` characters.
+ *
+ * - `max <= 0` → empty string
+ * - `max === 1` → first character of `text`
+ * - otherwise the result keeps a prefix and suffix of the original string
+ *   separated by a single ellipsis character (…)
+ */
+export function truncateMiddle(text: string, max: number): string {
+  if (max <= 0) return "";
+  if (text.length <= max) return text;
+  if (max === 1) return text[0] ?? "";
+
+  const ellipsis = "…";
+  const remaining = max - ellipsis.length;
+
+  const prefixLength = Math.ceil(remaining / 2);
+  const suffixLength = Math.floor(remaining / 2);
+
+  const start = text.slice(0, prefixLength);
+  const end = text.slice(text.length - suffixLength);
+
+  return `${start}${ellipsis}${end}`;
+}

```