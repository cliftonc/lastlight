/**
 * Deterministic, AI-free tests for the eval harness mechanism. These run in the
 * DEFAULT `npm test` suite (not the paid `*.eval.test.ts` suite) so the mock
 * plumbing is regression-guarded for free:
 *
 *   - the fake GitHub speaks enough REST for the real github_* tools;
 *   - agentic-pi's `githubApiBaseUrl` seam actually routes Octokit at it;
 *   - workspace seeding + execution grading flip red→green correctly.
 */

import { describe, it, expect } from "vitest";
import { GitHubClient } from "agentic-pi/dist/extensions/github/client.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace, seedWorkspaceFromGit } from "./seed.js";
import { gitDiffAgainstBase } from "./run-instance.js";
import { execFileSync } from "node:child_process";
import { gradeExecution, gradeBehavioral, gradeTriage } from "./grade.js";
import { loadMergedConfig, resolvePhaseModel } from "./config.js";
import { modelsArm, configArm, releaseOverlayGuard } from "./arm.js";

const staticAuth = { getToken: async () => "fake-token", expiresAt: null };

describe("fake GitHub + agentic-pi github tools (baseUrl seam)", () => {
  it("serves seeded issues and records mutations made through the real GitHubClient", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widget",
      issues: [{ number: 101, title: "Crash on empty config", body: "boom", labels: [] }],
    });
    try {
      // The REAL agentic-pi client, pointed at the fake via the released seam.
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });

      const issue = (await gh.getIssue("acme", "widget", 101)) as { number: number; title: string };
      expect(issue.number).toBe(101);
      expect(issue.title).toBe("Crash on empty config");

      await gh.createLabel("acme", "widget", "bug", "d73a4a");
      await gh.addLabels("acme", "widget", 101, ["bug", "ready-for-agent"]);
      await gh.addIssueComment("acme", "widget", 101, "Triaged — needs a repro first.");

      expect(fake.labelsOn(101)).toEqual(expect.arrayContaining(["bug", "ready-for-agent"]));
      expect(fake.commentsOn(101).some((c) => /repro/i.test(c))).toBe(true);
      expect(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("behavioral + triage grades read the recorded GitHub state", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widget",
      issues: [{ number: 7, title: "Q", body: "how?", labels: [] }],
    });
    try {
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      await gh.addLabels("acme", "widget", 7, ["question"]);

      const beh = gradeBehavioral({ labels_added: ["question"], labels_absent: ["ready-for-agent"] }, fake, { issueNumber: 7, branch: "main" });
      expect(beh.ok).toBe(true);

      const tri = gradeTriage({ category: "question" }, fake, 7);
      expect(tri.ok).toBe(true);

      const miss = gradeTriage({ state: "ready-for-agent" }, fake, 7);
      expect(miss.ok).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe("config run type — per-step model resolution (config.ts)", () => {
  it("deep-merges overlay config.yaml over core default.yaml (overlay wins per key)", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-cfg-"));
    try {
      // A stand-in core root: just the one file loadMergedConfig reads.
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(
        join(root, "config", "default.yaml"),
        "models:\n  default: anthropic/claude-sonnet-4-6\nvariants: {}\n",
      );
      // An overlay that retargets some phases + sets a variant.
      const overlay = join(root, "overlay");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(
        join(overlay, "config.yaml"),
        "models:\n  default: openai/gpt-5.4-mini\n  architect: openai/gpt-5.5\nvariants:\n  guardrails: low\n",
      );

      const { models, variants } = loadMergedConfig(root, overlay);
      expect(models.default).toBe("openai/gpt-5.4-mini"); // overlay wins
      expect(models.architect).toBe("openai/gpt-5.5"); // overlay-only key kept
      expect(variants.guardrails).toBe("low");

      // No overlay ⇒ just the core defaults.
      const core = loadMergedConfig(root);
      expect(core.models.default).toBe("anthropic/claude-sonnet-4-6");
      expect(core.models.architect).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolvePhaseModel mirrors core precedence: {{models.X}} template → models[phase] → default", () => {
    const models = { default: "m-default", guardrails: "m-guard", explore: "m-explore" };
    // 1. A phase whose YAML names `{{models.guardrails}}` → that template wins.
    expect(resolvePhaseModel("{{models.guardrails}}", "guardrails", models)).toBe("m-guard");
    // 2. A template keyed differently from the phase name (explore.yaml's
    //    `read_context` phase uses `{{models.explore}}`) → the TEMPLATE key wins,
    //    NOT the phase-name lookup. This is the case the `ctx.models` wiring guards.
    expect(resolvePhaseModel("{{models.explore}}", "read_context", models)).toBe("m-explore");
    // 3. No template, phase name present in the map → that entry.
    expect(resolvePhaseModel(undefined, "guardrails", models)).toBe("m-guard");
    // 4. No template, unmapped phase → the default.
    expect(resolvePhaseModel(undefined, "executor", models)).toBe("m-default");
    // 5. Template referencing an unset key → falls through to phase/default.
    expect(resolvePhaseModel("{{models.missing}}", "executor", models)).toBe("m-default");
  });
});

describe("Arm seam — model-selection adapters (arm.ts)", () => {
  // A stand-in core root (just the one file loadMergedConfig reads) + an overlay
  // that retargets some phases — mirrors the config.ts test fixtures.
  function makeRoots(): { root: string; overlay: string } {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-arm-"));
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "default.yaml"),
      "models:\n  default: anthropic/claude-sonnet-4-6\nvariants: {}\n",
    );
    const overlay = join(root, "overlay");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(
      join(overlay, "config.yaml"),
      "models:\n  default: openai/gpt-5.4-mini\n  architect: openai/gpt-5.5\nvariants:\n  guardrails: low\n",
    );
    return { root, overlay };
  }

  describe("modelsArm — one model forced across every step", () => {
    it("prepare() returns just the forced id and leaves ctx untouched", () => {
      const arm = modelsArm("openai/gpt-5.5", "OPENAI_API_KEY");
      expect(arm.label).toBe("openai/gpt-5.5");
      expect(arm.family).toBe("OPENAI_API_KEY");
      const ctx: Record<string, unknown> = {};
      const prepared = arm.prepare(ctx);
      // No per-step maps → core falls every phase back to config.model = the id.
      expect(prepared).toEqual({ model: "openai/gpt-5.5" });
      expect(prepared.models).toBeUndefined();
      expect(prepared.variants).toBeUndefined();
      expect(ctx.models).toBeUndefined();
      expect(ctx.variants).toBeUndefined();
    });

    it("recordPhaseModel() always reports the forced id; describe() is undefined", () => {
      const arm = modelsArm("openai/gpt-5.5", "OPENAI_API_KEY");
      // Even a phase naming a different model template runs the one forced id.
      expect(arm.recordPhaseModel("{{models.architect}}", "architect")).toBe("openai/gpt-5.5");
      expect(arm.recordPhaseModel(undefined, "executor")).toBe("openai/gpt-5.5");
      expect(arm.describe()).toBeUndefined();
    });

    it("activate() is a no-op (no overlay to switch)", () => {
      expect(() => modelsArm("m", "f").activate()).not.toThrow();
    });
  });

  describe("configArm — a deployment's per-step config drives selection", () => {
    it("prepare() patches ctx.models/variants and returns the merged maps + default", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay);
        expect(arm.label).toBe("overlay"); // basename(overlayDir)
        expect(arm.family).toBe("overlay"); // config arms are their own family
        const ctx: Record<string, unknown> = {};
        const prepared = arm.prepare(ctx);
        // The executor model is the merged default (the resolve fallback).
        expect(prepared.model).toBe("openai/gpt-5.4-mini");
        expect(prepared.models?.architect).toBe("openai/gpt-5.5");
        expect(prepared.variants?.guardrails).toBe("low");
        // Threaded onto ctx EXACTLY as prod, so `{{models.X}}` templates resolve.
        expect(ctx.models).toBe(prepared.models);
        expect(ctx.variants).toBe(prepared.variants);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("--model override replaces the merged default; no overlay ⇒ label 'config' + core defaults", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay, "fireworks/some-model");
        expect(arm.prepare({}).model).toBe("fireworks/some-model");

        const core = configArm(root, undefined);
        expect(core.label).toBe("config");
        expect(core.prepare({}).model).toBe("anthropic/claude-sonnet-4-6");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("recordPhaseModel() mirrors core precedence (template → phase → default); describe() summarises", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay);
        // A phase naming `{{models.architect}}` → the overlay's gpt-5.5.
        expect(arm.recordPhaseModel("{{models.architect}}", "architect")).toBe("openai/gpt-5.5");
        // An unmapped phase with no template → the merged default.
        expect(arm.recordPhaseModel(undefined, "executor")).toBe("openai/gpt-5.4-mini");
        const desc = arm.describe();
        expect(desc).toContain("default→openai/gpt-5.4-mini");
        expect(desc).toContain("architect→openai/gpt-5.5");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("overlay guard — the process-global asset root (ADR 0001)", () => {
    it("throws when a second, different overlay activates while one is in use; release clears it", () => {
      const { root, overlay } = makeRoots();
      const overlayB = join(root, "overlay-b");
      mkdirSync(overlayB, { recursive: true });
      writeFileSync(join(overlayB, "config.yaml"), "models:\n  default: openai/gpt-5.5\n");
      releaseOverlayGuard(); // clean slate regardless of test order
      try {
        const a = configArm(root, overlay);
        const b = configArm(root, overlayB);
        a.activate(); // first overlay — fine
        // A different overlay while `a` is still in use is the parallel footgun.
        expect(() => b.activate()).toThrow(/process-global|serially|in use/i);
        // Re-activating the SAME overlay is idempotent, not a conflict.
        expect(() => a.activate()).not.toThrow();
        // A release lets the next arm take over the global.
        releaseOverlayGuard();
        expect(() => b.activate()).not.toThrow();
      } finally {
        releaseOverlayGuard();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("workspace seed + execution grade (SWE-bench resolved)", () => {
  it("flips red→green when the bug is fixed, and detects PASS_TO_PASS regressions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-mech-"));
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      // Buggy: off-by-one (returns n + 2).
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 2;\n");

      const seeded = seedWorkspace({ stateDir, taskId: "mech-task", fixtureDir });
      expect(seeded.baseCommit).toHaveLength(40);

      // Held-out test the agent never saw.
      const heldOutDir = join(stateDir, "held");
      mkdirSync(heldOutDir, { recursive: true });
      writeFileSync(
        join(heldOutDir, "counter.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { next } from "./src/counter.ts";',
          'test("increments by one", () => { assert.equal(next(1), 2); });',
          'test("stays numeric", () => { assert.equal(typeof next(3), "number"); });',
        ].join("\n") + "\n",
      );

      // Before the fix → FAIL_TO_PASS test is red → not resolved.
      const before = gradeExecution({
        workDir: seeded.workDir,
        heldOutDir,
        failToPass: ["increments by one"],
        passToPass: ["stays numeric"],
      });
      expect(before.resolved).toBe(false);
      expect(before.failToPass.find((t) => t.id === "increments by one")?.pass).toBe(false);
      expect(before.passToPass.find((t) => t.id === "stays numeric")?.pass).toBe(true);

      // Apply the fix → both green → resolved.
      writeFileSync(join(seeded.workDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      const after = gradeExecution({
        workDir: seeded.workDir,
        failToPass: ["increments by one"],
        passToPass: ["stays numeric"],
      });
      expect(after.resolved).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('PASS_TO_PASS ["*"] requires the whole suite to stay green, not just named tests', () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-star-"));
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      const seeded = seedWorkspace({ stateDir, taskId: "star-task", fixtureDir });

      const heldOutDir = join(stateDir, "held");
      mkdirSync(heldOutDir, { recursive: true });
      writeFileSync(
        join(heldOutDir, "counter.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { next } from "./src/counter.ts";',
          'test("increments by one", () => { assert.equal(next(1), 2); });',
        ].join("\n") + "\n",
      );

      // Whole suite green → the wildcard regression guard resolves.
      const green = gradeExecution({
        workDir: seeded.workDir,
        heldOutDir,
        failToPass: ["increments by one"],
        passToPass: ["*"],
      });
      expect(green.resolved).toBe(true);
      expect(green.passToPass.find((t) => t.id === "* (all tests)")?.pass).toBe(true);

      // An unrelated test now fails: the named FAIL_TO_PASS is still green, but
      // ["*"] catches the regression → NOT resolved.
      writeFileSync(
        join(seeded.workDir, "unrelated.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("unrelated invariant", () => { assert.equal(1, 2); });',
        ].join("\n") + "\n",
      );
      const regressed = gradeExecution({
        workDir: seeded.workDir,
        failToPass: ["increments by one"],
        passToPass: ["*"],
      });
      expect(regressed.failToPass.find((t) => t.id === "increments by one")?.pass).toBe(true);
      expect(regressed.passToPass.find((t) => t.id === "* (all tests)")?.pass).toBe(false);
      expect(regressed.resolved).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("captures the agent's changes as a diff vs base — even after a commit (where `git diff HEAD` is empty)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-diff-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 2;\n");
      const seeded = seedWorkspace({ stateDir, taskId: "diff-task", fixtureDir, branch: "lastlight/fix" });

      // Simulate the agent: edit a file, add a NEW file, then commit (as the real
      // code-fix workflow does) so the working tree == HEAD.
      writeFileSync(join(seeded.workDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      writeFileSync(join(seeded.workDir, "NOTES.md"), "# fixed the off-by-one\n");
      g(seeded.workDir, "add", "-A");
      g(seeded.workDir, "-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "fix");

      // `git diff HEAD` is now empty (the prior bug) — but the diff vs base is not.
      expect(g(seeded.workDir, "diff", "HEAD").trim()).toBe("");
      const patch = gitDiffAgainstBase(seeded.workDir, seeded.baseCommit);
      expect(patch).toBeTruthy();
      expect(patch).toContain("src/counter.ts"); // the modified file
      expect(patch).toContain("NOTES.md"); // the new file
      expect(patch).toContain("+export const next = (n: number): number => n + 1;");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("suite mode: grades on the test command's exit code when there are no TAP names", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ll-eval-suite-"));
    try {
      const green = gradeExecution({ workDir, failToPass: [], passToPass: [], testCmd: ["node", "-e", "process.exit(0)"] });
      expect(green.resolved).toBe(true);
      const red = gradeExecution({ workDir, failToPass: [], passToPass: [], testCmd: ["node", "-e", "process.exit(1)"] });
      expect(red.resolved).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("git-source seeding (checkout a base commit, fully offline)", () => {
  it("checks out base_commit from a local mirror and sets up an offline push origin", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-gitsrc-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      // Build a source repo: base commit (val=base) then a later commit (val=head).
      const src = join(root, "src-repo");
      mkdirSync(src, { recursive: true });
      g(src, "init", "-q", "-b", "main");
      g(src, "config", "user.email", "t@t");
      g(src, "config", "user.name", "t");
      writeFileSync(join(src, "val.txt"), "base\n");
      g(src, "add", "-A");
      g(src, "commit", "-q", "-m", "base");
      const base = g(src, "rev-parse", "HEAD").trim();
      writeFileSync(join(src, "val.txt"), "head\n");
      g(src, "add", "-A");
      g(src, "commit", "-q", "-m", "head");

      // Pre-seed the cache mirror at the path ensureRepoCache expects, so no
      // network clone happens — the whole test is offline.
      const cache = join(root, "cache");
      mkdirSync(join(cache, "repos"), { recursive: true });
      g(join(cache, "repos"), "clone", "--bare", "--quiet", src, join(cache, "repos", "acme__widget.git"));

      const stateDir = join(root, "state");
      mkdirSync(stateDir, { recursive: true });
      process.env.LASTLIGHT_EVALS_CACHE = cache;
      const seeded = seedWorkspaceFromGit({
        stateDir,
        taskId: "gitsrc-task",
        repo: "acme/widget",
        baseCommit: base,
        branch: "lastlight/fix",
      });

      expect(seeded.baseCommit).toBe(base);
      expect(seeded.branch).toBe("lastlight/fix");
      // Working tree is the BASE state, not head.
      expect(readFileSync(join(seeded.workDir, "val.txt"), "utf8")).toBe("base\n");
      // The offline origin accepts a push (proves `git push` works with no network).
      writeFileSync(join(seeded.workDir, "fix.txt"), "fixed\n");
      g(seeded.workDir, "add", "-A");
      g(seeded.workDir, "-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "fix");
      expect(() => g(seeded.workDir, "push", "-q", "origin", "HEAD:refs/heads/lastlight/fix")).not.toThrow();
    } finally {
      delete process.env.LASTLIGHT_EVALS_CACHE;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
