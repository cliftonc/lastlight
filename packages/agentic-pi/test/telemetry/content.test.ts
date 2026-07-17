import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { redact, MAX_CONTENT_CHARS } from "../../src/telemetry/config.js";

describe("redact — content gating", () => {
  test("returns undefined when content export is off", () => {
    assert.equal(redact("secret prompt", false), undefined);
    assert.equal(redact({ a: 1 }, false), undefined);
  });

  test("passes through short strings when on", () => {
    assert.equal(redact("hello", true), "hello");
  });

  test("stringifies non-string values when on", () => {
    assert.equal(redact({ command: "ls" }, true), '{"command":"ls"}');
  });

  test("undefined/null yield undefined even when on", () => {
    assert.equal(redact(undefined, true), undefined);
    assert.equal(redact(null, true), undefined);
  });

  test("truncates oversized content with a marker", () => {
    const big = "x".repeat(MAX_CONTENT_CHARS + 500);
    const out = redact(big, true);
    assert.ok(out);
    assert.ok(out!.length < big.length);
    assert.ok(out!.startsWith("x".repeat(MAX_CONTENT_CHARS)));
    assert.match(out!, /truncated 500 chars/);
  });

  test("does not truncate content exactly at the limit", () => {
    const exact = "y".repeat(MAX_CONTENT_CHARS);
    assert.equal(redact(exact, true), exact);
  });
});
