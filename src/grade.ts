/**
 * Deterministic grading — two signals, no LLM judge.
 *
 *  - Execution (code-fix): copy the held-out tests into the workspace the agent
 *    left behind, run them, and require every FAIL_TO_PASS test to pass and
 *    every PASS_TO_PASS test to stay green. This is SWE-bench's resolved
 *    criterion.
 *  - Behavioral: compare the GitHub mutations the workflow performed (recorded
 *    by the fake GitHub) against the instance's expectations. For triage this
 *    is the primary signal (its output IS GitHub state).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExpectGithub } from "./schema.js";
import type { FakeGitHub } from "./fake-github.js";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

// ── Behavioral grade ────────────────────────────────────────────────────────

export function gradeBehavioral(
  expect: ExpectGithub | undefined,
  fake: FakeGitHub,
  ctx: { issueNumber: number; branch: string },
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  if (!expect) return { ok: true, checks };

  const labels = fake.labelsOn(ctx.issueNumber);
  for (const want of expect.labels_added ?? []) {
    checks.push({ name: `label:${want}`, ok: labels.includes(want), detail: `labels=[${labels.join(", ")}]` });
  }
  for (const absent of expect.labels_absent ?? []) {
    checks.push({ name: `no-label:${absent}`, ok: !labels.includes(absent) });
  }
  if (expect.issue_closed !== undefined) {
    const closed = fake.issueState(ctx.issueNumber) === "closed";
    checks.push({ name: "issue-closed", ok: closed === expect.issue_closed });
  }
  if (expect.comment_matches) {
    const re = new RegExp(expect.comment_matches, "i");
    const comments = fake.commentsOn(ctx.issueNumber);
    checks.push({
      name: `comment~/${expect.comment_matches}/`,
      ok: comments.some((c) => re.test(c)),
      detail: `${comments.length} comment(s)`,
    });
  }
  if (expect.pr_opened) {
    const prs = fake.pulls();
    const pr = prs[0];
    let ok = prs.length > 0;
    let detail = `${prs.length} PR(s)`;
    if (pr) {
      if (expect.pr_opened.base) ok = ok && pr.base.ref === expect.pr_opened.base;
      if (expect.pr_opened.head_is_branch) ok = ok && pr.head.ref === ctx.branch;
      if (expect.pr_opened.title_matches) ok = ok && new RegExp(expect.pr_opened.title_matches, "i").test(pr.title);
      detail = `head=${pr.head.ref} base=${pr.base.ref} title="${pr.title}"`;
    }
    checks.push({ name: "pr-opened", ok, detail });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── Triage gold grade (label-accuracy) ──────────────────────────────────────

/** Canonical triage role names ARE the label strings (see skills/issue-triage). */
export function gradeTriage(
  gold: { category?: string; state?: string } | undefined,
  fake: FakeGitHub,
  issueNumber: number,
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  if (!gold) return { ok: true, checks };
  const labels = fake.labelsOn(issueNumber);
  if (gold.category) checks.push({ name: `category=${gold.category}`, ok: labels.includes(gold.category), detail: `labels=[${labels.join(", ")}]` });
  if (gold.state) checks.push({ name: `state=${gold.state}`, ok: labels.includes(gold.state), detail: `labels=[${labels.join(", ")}]` });
  return { ok: checks.every((c) => c.ok), checks };
}

// ── Execution grade (SWE-bench resolved) ────────────────────────────────────

const TAP_LINE = /^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/;

export interface ExecutionGrade {
  resolved: boolean;
  failToPass: { id: string; pass: boolean }[];
  passToPass: { id: string; pass: boolean }[];
  raw: string;
}

export function gradeExecution(opts: {
  workDir: string;
  /** Directory of held-out test files to copy in before running (SWE-bench's test_patch, file form). */
  heldOutDir?: string;
  /** Or a unified diff to `git apply` (real SWE-bench instances). */
  testPatch?: string;
  failToPass: string[];
  passToPass: string[];
  /** Override the test command argv (default: node --test over *.test.ts). */
  testCmd?: string[];
  /** Optional install/build argv run in `workDir` BEFORE the tests (git-source
   * repos that need deps, e.g. `["npm","ci"]`). Runs untrusted repo code. */
  setupCmd?: string[];
}): ExecutionGrade {
  // Apply held-out tests the agent never saw.
  if (opts.heldOutDir && existsSync(opts.heldOutDir)) {
    cpSync(opts.heldOutDir, opts.workDir, { recursive: true });
  }
  if (opts.testPatch) {
    const patchFile = join(opts.workDir, ".eval-test.patch");
    writeFileSync(patchFile, opts.testPatch);
    execFileSync("git", ["apply", patchFile], { cwd: opts.workDir, stdio: ["ignore", "pipe", "pipe"] });
  }

  let setupLog = "";
  if (opts.setupCmd?.length) {
    const [bin, ...rest] = opts.setupCmd;
    try {
      setupLog = execFileSync(bin, rest, {
        cwd: opts.workDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      }).toString();
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      setupLog = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    }
  }

  // The default runner emits TAP we can parse per-test; a custom `test_cmd` may
  // not — that's fine, suite mode below falls back to the exit code.
  const isDefaultRunner = !opts.testCmd;
  const testFiles = isDefaultRunner ? listTestFiles(opts.workDir) : [];
  const argv = opts.testCmd ?? [
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "--experimental-strip-types",
    ...testFiles,
  ];

  let raw = "";
  let exitOk = false;
  try {
    raw = execFileSync(argv[0], argv.slice(1), {
      cwd: opts.workDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).toString();
    exitOk = true;
  } catch (err) {
    // A failing test run exits non-zero; its stdout still holds the TAP/log.
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    raw = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }

  const passed = parseTap(raw);
  // Named mode when at least one FAIL_TO_PASS id shows up in the TAP stream;
  // otherwise suite mode — grade on the command's exit code.
  const named = opts.failToPass.length > 0 && opts.failToPass.some((id) => passed.has(id));

  // `PASS_TO_PASS: ["*"]` is a wildcard meaning "the ENTIRE suite must stay
  // green" — far more robust than pinning every test by name (which breaks the
  // moment a test is renamed or added). It resolves to the run being green: the
  // command exited 0 and no TAP line reported `not ok`. Other PASS_TO_PASS names
  // (if any) are still checked individually alongside it.
  const passAll = opts.passToPass.includes("*");
  const explicitPass = opts.passToPass.filter((id) => id !== "*");
  const suiteGreen = exitOk && [...passed.values()].every(Boolean);

  let fail: { id: string; pass: boolean }[];
  let pass: { id: string; pass: boolean }[];
  let resolved: boolean;
  if (named) {
    fail = opts.failToPass.map((id) => ({ id, pass: passed.get(id) === true }));
    pass = explicitPass.map((id) => ({ id, pass: passed.get(id) === true }));
    if (passAll) pass.push({ id: "* (all tests)", pass: suiteGreen });
    resolved = fail.every((t) => t.pass) && pass.every((t) => t.pass);
  } else {
    // Suite mode: the held-out tests pass iff the command exited 0. Report each
    // declared id against that single outcome; honor any PASS_TO_PASS names that
    // did surface in TAP.
    fail = opts.failToPass.map((id) => ({ id, pass: exitOk }));
    pass = explicitPass.map((id) => ({ id, pass: passed.has(id) ? passed.get(id) === true : exitOk }));
    if (passAll) pass.push({ id: "* (all tests)", pass: suiteGreen });
    resolved = exitOk && pass.every((t) => t.pass);
  }
  return { resolved, failToPass: fail, passToPass: pass, raw: setupLog ? `${setupLog}\n${raw}` : raw };
}

function parseTap(raw: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(TAP_LINE);
    if (!m) continue;
    out.set(m[2].trim(), m[1] === "ok");
  }
  return out;
}

function listTestFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listTestFiles(join(dir, ent.name), rel));
    else if (/\.test\.(ts|tsx|mts|js|mjs)$/.test(ent.name)) out.push(rel);
  }
  return out;
}
