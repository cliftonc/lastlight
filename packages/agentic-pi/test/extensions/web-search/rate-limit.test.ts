import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "../../../src/extensions/web-search/rate-limit.js";

describe("RateLimiter", () => {
  test("permits up to max calls then refuses", () => {
    const r = new RateLimiter(3);
    assert.equal(r.consume(), true);
    assert.equal(r.consume(), true);
    assert.equal(r.consume(), true);
    assert.equal(r.consume(), false);
    assert.equal(r.consume(), false);
  });

  test("remaining tracks usage", () => {
    const r = new RateLimiter(2);
    assert.equal(r.remaining, 2);
    r.consume();
    assert.equal(r.remaining, 1);
    r.consume();
    assert.equal(r.remaining, 0);
    r.consume();
    assert.equal(r.remaining, 0);
  });
});
