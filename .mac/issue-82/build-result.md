# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/utils/date.test.ts, src/utils/date.ts

## Code diff
```diff
diff --git a/src/utils/date.test.ts b/src/utils/date.test.ts
new file mode 100644
index 0000000..22e8c12
--- /dev/null
+++ b/src/utils/date.test.ts
@@ -0,0 +1,59 @@
+import { describe, expect, it } from 'vitest';
+import { weeksBetween } from './date.js';
+
+describe('weeksBetween', () => {
+  it('returns 0 for the same date', () => {
+    const a = new Date('2024-01-01');
+    const b = new Date('2024-01-01');
+
+    expect(weeksBetween(a, b)).toBe(0);
+  });
+
+  it('returns 0 when dates are less than one week apart', () => {
+    const a = new Date('2024-01-01');
+    const b = new Date('2024-01-04');
+
+    expect(weeksBetween(a, b)).toBe(0);
+  });
+
+  it('returns 1 when dates are exactly one week apart', () => {
+    const a = new Date('2024-01-01');
+    const b = new Date('2024-01-08');
+
+    expect(weeksBetween(a, b)).toBe(1);
+  });
+
+  it('returns the number of full weeks between dates', () => {
+    const a = new Date('2024-01-01');
+    const b = new Date('2024-01-29'); // 4 weeks apart
+
+    expect(weeksBetween(a, b)).toBe(4);
+  });
+
+  it('is symmetric with respect to argument order', () => {
+    const a = '2024-01-01';
+    const b = '2024-02-01';
+
+    expect(weeksBetween(a, b)).toBe(weeksBetween(b, a));
+  });
+
+  it('accepts a mix of Date and string inputs', () => {
+    const a = new Date('2024-01-01');
+    const b = '2024-01-15';
+
+    expect(weeksBetween(a, b)).toBe(2);
+  });
+
+  it('normalizes time-of-day differences via UTC midnight', () => {
+    const a = new Date('2024-01-01T23:59:59.000Z');
+    const b = new Date('2024-01-08T00:00:01.000Z');
+
+    expect(weeksBetween(a, b)).toBe(1);
+  });
+
+  it('throws a useful error on invalid dates', () => {
+    expect(() => weeksBetween('not-a-date' as string, '2024-01-01')).toThrow(
+      /Invalid date input/,
+    );
+  });
+});
diff --git a/src/utils/date.ts b/src/utils/date.ts
new file mode 100644
index 0000000..90d5f67
--- /dev/null
+++ b/src/utils/date.ts
@@ -0,0 +1,33 @@
+/**
+ * Returns the number of whole calendar weeks between two dates.
+ *
+ * Both inputs are normalized to UTC midnight before computing the
+ * difference, so the result is independent of time-of-day or local
+ * timezone/DST differences. The result is always a non-negative integer.
+ */
+export function weeksBetween(a: Date | string, b: Date | string): number {
+  const dateA = toValidDate(a, 'a');
+  const dateB = toValidDate(b, 'b');
+
+  const normalizedA = normalizeToUtcMidnight(dateA);
+  const normalizedB = normalizeToUtcMidnight(dateB);
+
+  const diffMs = Math.abs(normalizedA.getTime() - normalizedB.getTime());
+  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
+
+  return Math.floor(diffMs / MS_PER_WEEK);
+}
+
+function toValidDate(value: Date | string, label: string): Date {
+  const date = value instanceof Date ? value : new Date(value);
+
+  if (Number.isNaN(date.getTime())) {
+    throw new Error(`Invalid date input for ${label}`);
+  }
+
+  return date;
+}
+
+function normalizeToUtcMidnight(date: Date): Date {
+  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
+}

```