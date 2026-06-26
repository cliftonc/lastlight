import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fork, resolveForkTarget } from "./fork-cli.js";

const WORKFLOW_YAML = `
kind: build
name: build
description: "test build"
phases:
  - name: phase_0
    type: context
  - name: architect
    prompt: prompts/architect.md
    skill: building
  - name: reviewer
    prompt: prompts/reviewer.md
    skills: [code-review, building]
    loop:
      max_cycles: 2
      on_request_changes:
        fix_prompt: prompts/fix.md
        re_review_prompt: prompts/re-reviewer.md
`;

function makeCore(): string {
  const root = mkdtempSync(join(tmpdir(), "fork-cli-"));
  const core = join(root, "core");
  mkdirSync(join(core, "workflows", "prompts"), { recursive: true });
  mkdirSync(join(core, "skills", "building", "scripts"), { recursive: true });
  mkdirSync(join(core, "skills", "code-review"), { recursive: true });
  mkdirSync(join(core, "agent-context"), { recursive: true });

  writeFileSync(join(core, "workflows", "build.yaml"), WORKFLOW_YAML);
  for (const p of ["architect", "reviewer", "fix", "re-reviewer"]) {
    writeFileSync(join(core, "workflows", "prompts", `${p}.md`), `# ${p} (core)`);
  }
  writeFileSync(join(core, "skills", "building", "SKILL.md"), "# building (core)");
  writeFileSync(join(core, "skills", "building", "scripts", "run.sh"), "echo hi");
  writeFileSync(join(core, "skills", "code-review", "SKILL.md"), "# code-review (core)");
  writeFileSync(join(core, "agent-context", "soul.md"), "# soul (core)");
  writeFileSync(join(core, "agent-context", "rules.md"), "# rules (core)");
  return core;
}

describe("fork-cli", () => {
  let core: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    core = makeCore();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("resolveForkTarget honours an explicit --home over cwd", () => {
    const t = resolveForkTarget({ home: "/tmp/somewhere" });
    expect(t.coreRoot).toBe("/tmp/somewhere");
    expect(t.instanceDir).toBe("/tmp/somewhere/instance");
  });

  it("forks a workflow plus every referenced prompt and skill", async () => {
    await fork(["build"], { home: core });
    const inst = join(core, "instance");
    expect(existsSync(join(inst, "workflows", "build.yaml"))).toBe(true);
    for (const p of ["architect", "reviewer", "fix", "re-reviewer"]) {
      expect(existsSync(join(inst, "workflows", "prompts", `${p}.md`))).toBe(true);
    }
    expect(existsSync(join(inst, "skills", "building", "SKILL.md"))).toBe(true);
    // Whole skill directory travels, including scripts/.
    expect(existsSync(join(inst, "skills", "building", "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(inst, "skills", "code-review", "SKILL.md"))).toBe(true);
  });

  it("skips existing assets by default and overwrites with --force", async () => {
    const inst = join(core, "instance");
    mkdirSync(join(inst, "workflows"), { recursive: true });
    writeFileSync(join(inst, "workflows", "build.yaml"), "SENTINEL");

    await fork(["build"], { home: core });
    expect(readFileSync(join(inst, "workflows", "build.yaml"), "utf8")).toBe("SENTINEL");

    await fork(["build"], { home: core, force: true });
    expect(readFileSync(join(inst, "workflows", "build.yaml"), "utf8")).toContain("name: build");
  });

  it("forks all agent-context files via the explicit target", async () => {
    await fork(["agent-context"], { home: core });
    const ctx = join(core, "instance", "agent-context");
    expect(existsSync(join(ctx, "soul.md"))).toBe(true);
    expect(existsSync(join(ctx, "rules.md"))).toBe(true);
  });

  it("forks a single named agent-context file", async () => {
    await fork(["agent-context", "soul.md"], { home: core });
    const ctx = join(core, "instance", "agent-context");
    expect(existsSync(join(ctx, "soul.md"))).toBe(true);
    expect(existsSync(join(ctx, "rules.md"))).toBe(false);
  });

  it("does not infer agent-context from a bare filename", async () => {
    // `soul` is not a workflow and not the explicit agent-context target → error.
    await expect(fork(["soul"], { home: core })).rejects.toThrow(/process\.exit/);
    expect(existsSync(join(core, "instance", "agent-context", "soul.md"))).toBe(false);
  });

  it("errors on an unknown workflow target", async () => {
    await expect(fork(["nope"], { home: core })).rejects.toThrow(/process\.exit/);
    expect(errSpy).toHaveBeenCalled();
  });
});
