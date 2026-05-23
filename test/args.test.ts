import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  test("--model is required", () => {
    assert.throws(() => parseArgs([]), /--model is required/);
  });

  test("--model must be 'provider/id'", () => {
    assert.throws(
      () => parseArgs(["--model", "gpt-4"]),
      /must be 'provider\/id'/,
    );
  });

  test("minimal happy path", () => {
    const cfg = parseArgs(["--model", "openai/gpt-4"]);
    assert.equal(cfg.model, "openai/gpt-4");
    assert.equal(cfg.sandbox, "none");
    assert.equal(cfg.noSession, false);
    assert.equal(cfg.dangerouslySkipPermissions, false);
  });

  test("--thinking accepts valid levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      const cfg = parseArgs(["--model", "openai/gpt-4", "--thinking", level]);
      assert.equal(cfg.thinking, level);
    }
  });

  test("--variant is an alias for --thinking", () => {
    const cfg = parseArgs(["--model", "openai/gpt-4", "--variant", "high"]);
    assert.equal(cfg.thinking, "high");
  });

  test("--thinking rejects invalid levels", () => {
    assert.throws(
      () => parseArgs(["--model", "openai/gpt-4", "--thinking", "extreme"]),
      /invalid --thinking/,
    );
  });

  test("--sandbox accepts none and gondolin", () => {
    assert.equal(
      parseArgs(["--model", "openai/gpt-4", "--sandbox", "none"]).sandbox,
      "none",
    );
    assert.equal(
      parseArgs(["--model", "openai/gpt-4", "--sandbox", "gondolin"]).sandbox,
      "gondolin",
    );
  });

  test("--sandbox rejects unknown values", () => {
    assert.throws(
      () => parseArgs(["--model", "openai/gpt-4", "--sandbox", "firecracker"]),
      /invalid --sandbox/,
    );
  });

  test("--dangerously-skip-permissions is accepted (no-op)", () => {
    const cfg = parseArgs([
      "--model",
      "openai/gpt-4",
      "--dangerously-skip-permissions",
    ]);
    assert.equal(cfg.dangerouslySkipPermissions, true);
  });

  test("--tools parses comma-separated list", () => {
    const cfg = parseArgs(["--model", "openai/gpt-4", "--tools", "read,bash,github_get_repository"]);
    assert.deepEqual(cfg.tools, ["read", "bash", "github_get_repository"]);
  });

  test("--no-session and --no-builtin-tools are boolean", () => {
    const cfg = parseArgs([
      "--model",
      "openai/gpt-4",
      "--no-session",
      "--no-builtin-tools",
    ]);
    assert.equal(cfg.noSession, true);
    assert.equal(cfg.noBuiltinTools, true);
  });

  test("unknown flag throws", () => {
    assert.throws(
      () => parseArgs(["--model", "openai/gpt-4", "--bogus"]),
      /unknown flag/,
    );
  });

  test("flag without value throws", () => {
    assert.throws(
      () => parseArgs(["--model"]),
      /requires a value/,
    );
  });
});
