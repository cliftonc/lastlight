import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseModelSpec } from "../src/models.js";

describe("parseModelSpec", () => {
  test("splits 'provider/id' on the first slash", () => {
    assert.deepEqual(parseModelSpec("anthropic/claude-opus-4-5"), {
      provider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    assert.deepEqual(parseModelSpec("openai/gpt-5.4-nano"), {
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
  });

  test("preserves slashes inside the model id (openrouter style)", () => {
    assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-3.5-sonnet"), {
      provider: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
    });
  });

  test("rejects bare model with no slash", () => {
    assert.throws(() => parseModelSpec("gpt-4"), /provider\/id/);
  });

  test("rejects empty provider or id", () => {
    assert.throws(() => parseModelSpec("/foo"), /provider\/id/);
    assert.throws(() => parseModelSpec("openai/"), /provider\/id/);
  });
});
