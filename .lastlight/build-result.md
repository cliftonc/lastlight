# Build result

- final verdict: REQUEST_CHANGES
- review cycles: 1
- files changed: package-lock.json, src/truncateMiddle.test.ts, src/util.ts

## Code diff
```diff
diff --git a/package-lock.json b/package-lock.json
index 3904098..69c6a17 100644
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
@@ -1964,7 +1964,7 @@
         "typebox": "1.1.38"
       },
       "bin": {
-        "pi-ai": "./dist/cli.js"
+        "pi-ai": "dist/cli.js"
       },
       "engines": {
         "node": ">=22.19.0"
diff --git a/src/truncateMiddle.test.ts b/src/truncateMiddle.test.ts
new file mode 100644
index 0000000..b2056b1
--- /dev/null
+++ b/src/truncateMiddle.test.ts
@@ -0,0 +1,45 @@
+import { describe, it, expect } from "vitest";
+import { truncateMiddle } from "./util.js";
+
+describe("truncateMiddle", () => {
+  it("returns short strings unchanged when below max", () => {
+    const text = "short";
+    const max = 10;
+
+    const result = truncateMiddle(text, max);
+
+    expect(result).toBe(text);
+  });
+
+  it("returns exact-length strings unchanged", () => {
+    const text = "exact-len";
+    const max = text.length;
+
+    const result = truncateMiddle(text, max);
+
+    expect(result).toBe(text);
+  });
+
+  it("truncates long strings in the middle with an ellipsis", () => {
+    const text = "abcdefghijklmnopqrstuvwxyz";
+    const max = 10;
+
+    const result = truncateMiddle(text, max);
+
+    expect(result.length).toBeLessThanOrEqual(max);
+    expect(result).toContain("…");
+
+    const ellipsis = "…";
+    const remaining = max - ellipsis.length;
+    const expectedPrefixLength = Math.ceil(remaining / 2);
+    const expectedSuffixLength = Math.floor(remaining / 2);
+
+    expect(result.startsWith(text.slice(0, expectedPrefixLength))).toBe(true);
+    expect(result.endsWith(text.slice(text.length - expectedSuffixLength))).toBe(true);
+  });
+
+  it("handles small max values", () => {
+    expect(truncateMiddle("abc", 1)).toBe("…");
+    expect(truncateMiddle("abc", 0)).toBe("");
+  });
+});
diff --git a/src/util.ts b/src/util.ts
new file mode 100644
index 0000000..269c8d1
--- /dev/null
+++ b/src/util.ts
@@ -0,0 +1,25 @@
+/**
+ * Truncate a string in the middle with an ellipsis so that the result length
+ * is at most `max` characters.
+ *
+ * - If `max <= 0`, returns an empty string.
+ * - If `max === 1`, returns only the ellipsis character.
+ * - If the input length is already `<= max`, returns the original string.
+ */
+export function truncateMiddle(text: string, max: number): string {
+  if (max <= 0) return "";
+  if (text.length <= max) return text;
+
+  const ellipsis = "…";
+
+  if (max === 1) return ellipsis;
+
+  const remaining = max - ellipsis.length; // characters available for prefix + suffix
+  const prefixLength = Math.ceil(remaining / 2);
+  const suffixLength = Math.floor(remaining / 2);
+
+  const prefix = text.slice(0, prefixLength);
+  const suffix = text.slice(text.length - suffixLength);
+
+  return prefix + ellipsis + suffix;
+}

```