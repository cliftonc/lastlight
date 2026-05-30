# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/utils/formatDate.test.ts, src/utils/formatDate.ts

## Code diff
```diff
diff --git a/src/utils/formatDate.test.ts b/src/utils/formatDate.test.ts
new file mode 100644
index 0000000..c7ef2d8
--- /dev/null
+++ b/src/utils/formatDate.test.ts
@@ -0,0 +1,26 @@
+import { describe, expect, it } from "vitest";
+import { formatDateYYYYMMDD } from "./formatDate.js";
+
+describe("formatDateYYYYMMDD", () => {
+  it("formats a standard date", () => {
+    const date = new Date(2024, 0, 15); // 15 Jan 2024
+    expect(formatDateYYYYMMDD(date)).toBe("2024, 01, 15");
+  });
+
+  it("pads single-digit month and day with leading zeros", () => {
+    expect(formatDateYYYYMMDD(new Date(2024, 0, 1))).toBe("2024, 01, 01");
+    expect(formatDateYYYYMMDD(new Date(2024, 8, 9))).toBe("2024, 09, 09");
+  });
+
+  it("handles different years", () => {
+    expect(formatDateYYYYMMDD(new Date(1999, 11, 31))).toBe("1999, 12, 31");
+    expect(formatDateYYYYMMDD(new Date(2100, 5, 10))).toBe("2100, 06, 10");
+  });
+
+  it("throws on invalid Date instances", () => {
+    const invalid = new Date(NaN);
+    expect(() => formatDateYYYYMMDD(invalid)).toThrowError(
+      /expected a valid Date instance/
+    );
+  });
+});
diff --git a/src/utils/formatDate.ts b/src/utils/formatDate.ts
new file mode 100644
index 0000000..1d10861
--- /dev/null
+++ b/src/utils/formatDate.ts
@@ -0,0 +1,17 @@
+/**
+ * Format a Date into a string in the form `YYYY, MM, DD`.
+ *
+ * This function uses the local time zone via Date#getFullYear/#getMonth/#getDate.
+ * It throws a TypeError if the provided Date is invalid (e.g. `new Date(NaN)`).
+ */
+export function formatDateYYYYMMDD(date: Date): string {
+  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
+    throw new TypeError("formatDateYYYYMMDD expected a valid Date instance");
+  }
+
+  const year = date.getFullYear();
+  const month = String(date.getMonth() + 1).padStart(2, "0");
+  const day = String(date.getDate()).padStart(2, "0");
+
+  return `${year}, ${month}, ${day}`;
+}

```