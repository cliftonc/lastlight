/**
 * `lastlight-evals add-case` — scaffold an eval instance from a real GitHub PR
 * (code-fix) or issue (triage).
 *
 * This does the MECHANICAL, reproducible extraction; the `lastlight-evals` agent
 * skill drives it and refines the fuzzy parts (held-out test selection, the
 * problem statement, FAIL_TO_PASS names). From a PR it derives:
 *   - `repo` + `base_commit` (the true fork point: merge-base of base & head)
 *     + `head_commit`,
 *   - `test_patch`  — the diff of the PR's TEST files (held out at grade time),
 *   - gold `patch`  — the diff of the non-test files (reference only),
 *   - `FAIL_TO_PASS` / `PASS_TO_PASS` — auto-detected by running the tests at
 *     base (red) vs head (green) when validation is enabled,
 *   - the issue fixture + `expect_github`.
 *
 * The produced instance is a **git-source** case: no `repos/<id>/` fixture is
 * written — at run time the harness clones the real repo into the repo-local
 * cache and checks out `base_commit` (see `seedWorkspaceFromGit`).
 *
 * Validation and the run-time checkout execute the repo's own code (`setup_cmd`
 * / `test_cmd` / its tests). Only point this at repos you trust.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import chalk from "chalk";

import type { SweBenchInstance, IssueSeed } from "./schema.js";
import { ensureRepoCache } from "./seed.js";

const ADD_CASE_USAGE = `lastlight-evals add-case --pr <url> | --issue <url> [options]

Scaffold an eval instance from a real GitHub PR (code-fix) or issue (triage).

Options:
  --pr <url>            GitHub PR url → a code-fix (build) case
  --issue <url>         GitHub issue url → a triage case
  --tier <name>         Target tier dir (default: code-fix for --pr, triage for --issue)
  --id <slug>           instance_id (default: derived from repo + number)
  --datasets <dir>      Datasets root to write into (a <tier>/ subdir)
  --overlay <dir>       Write into <dir>/evals/datasets instead
  --test-cmd "<cmd>"    Held-out test command (default: node --test). Stored as test_cmd.
  --setup-cmd "<cmd>"   Install/build run before tests (e.g. "npm ci"). Stored as setup_cmd.
  --hold-out            SWE-bench style: hold the PR's test files out of the agent's
                        repo and apply them only at grade time, scored by named
                        FAIL_TO_PASS. Default is SUITE mode — grade on the repo's own
                        test_cmd run against the agent's final tree (nothing held out).
  --pass-list           (hold-out only) Enumerate every green test in PASS_TO_PASS.
                        Default is PASS_TO_PASS=["*"] (the whole suite must stay green).
  --no-validate         Don't run the repo's tests to validate the case (just scaffold)
  --dry-run             Print the proposed instance JSON; don't write
  -h, --help            Show this help

The repo's tests/setup run real code — only use trusted repos.`;

// ── small shells ────────────────────────────────────────────────────────────

function sh(bin: string, args: string[], cwd?: string): string {
  return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function ghJson<T>(args: string[]): T {
  return JSON.parse(sh("gh", args)) as T;
}
/** Run a test/setup command, recovering output + exit status (never throws). */
function runCmd(argv: string[], cwd: string): { ok: boolean; raw: string } {
  try {
    const raw = execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, raw };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, raw: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const TAP_LINE = /^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/;
function parseTap(raw: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(TAP_LINE);
    if (m) out.set(m[2].trim(), m[1] === "ok");
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseRepoFromUrl(url: string): { owner: string; name: string; number: number } {
  const m = url.match(/github\.com[/:]+([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/i);
  if (!m) throw new Error(`Not a GitHub PR/issue url: ${url}`);
  return { owner: m[1], name: m[2].replace(/\.git$/, ""), number: Number(m[3]) };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z0-9]+$/i;
function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}

/** Split argv from a `--test-cmd "npm test"` style flag (whitespace split). */
function parseCmd(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Resolve the datasets root to write the tier into. */
function resolveWriteRoot(opts: { datasets?: string; overlay?: string }): string {
  if (opts.datasets) return resolve(opts.datasets);
  if (opts.overlay) return resolve(opts.overlay, "evals", "datasets");
  if (existsSync(resolve("datasets"))) return resolve("datasets");
  return resolve("evals", "datasets");
}

/** Append (or replace by id) an instance into `<root>/<tier>/instances.json`,
 * creating the tier dir + a `tier.json` when absent. */
function writeInstance(root: string, tier: string, defaultWorkflow: string, inst: SweBenchInstance): string {
  const tierDir = join(root, tier);
  mkdirSync(tierDir, { recursive: true });
  const tierJson = join(tierDir, "tier.json");
  if (!existsSync(tierJson)) {
    writeFileSync(tierJson, JSON.stringify({ name: tier, defaultWorkflow, description: `${tier} cases.` }, null, 2) + "\n");
  }
  const instancesPath = join(tierDir, "instances.json");
  const arr: SweBenchInstance[] = existsSync(instancesPath)
    ? (JSON.parse(readFileSync(instancesPath, "utf8")) as SweBenchInstance[])
    : [];
  const at = arr.findIndex((i) => i.instance_id === inst.instance_id);
  if (at >= 0) arr[at] = inst;
  else arr.push(inst);
  writeFileSync(instancesPath, JSON.stringify(arr, null, 2) + "\n");
  return instancesPath;
}

// ── PR → code-fix case ──────────────────────────────────────────────────────

interface PrView {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  url: string;
  // `gh pr view --json closingIssuesReferences` only returns id/number/url/repository
  // per linked issue — NOT title/body. Those are fetched separately (fetchLinkedIssue).
  closingIssuesReferences?: { number: number }[];
}

interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

/** Fetch a linked closing issue's title/body. `gh pr view`'s
 * `closingIssuesReferences` omits them (it returns only number/url/id/repository),
 * so a bare interpolation of `linked.title`/`linked.body` would yield the literal
 * string "undefined". Returns undefined if the issue can't be read (private/gone),
 * letting the caller fall back to the PR's own title/body. */
function fetchLinkedIssue(repo: string, number: number): LinkedIssue | undefined {
  try {
    const iss = ghJson<{ number: number; title: string; body?: string }>([
      "issue", "view", String(number), "--repo", repo, "--json", "number,title,body",
    ]);
    return { number: iss.number, title: iss.title, body: iss.body ?? "" };
  } catch {
    return undefined;
  }
}

async function fromPr(url: string, o: Options): Promise<number> {
  const { owner, name } = parseRepoFromUrl(url);
  const repo = `${owner}/${name}`;
  console.log(chalk.dim(`Resolving PR ${repo}#${parseRepoFromUrl(url).number}…`));

  const pr = ghJson<PrView>([
    "pr", "view", url,
    "--json", "number,title,body,baseRefName,headRefName,headRefOid,url,closingIssuesReferences",
  ]);

  // Mirror the repo locally and pull in the PR head ref (it may live on a fork).
  const mirror = ensureRepoCache({ repo });
  const headRef = `refs/eval/pr-${pr.number}`;
  sh("git", ["fetch", "--quiet", "origin", `pull/${pr.number}/head:${headRef}`], mirror);
  const head = pr.headRefOid || sh("git", ["rev-parse", headRef], mirror).trim();
  // Make sure the base branch is present (default mirror has refs/heads/*).
  const base = sh("git", ["merge-base", `refs/heads/${pr.baseRefName}`, head], mirror).trim();

  // The non-test code change is the gold patch (reference only) in both modes.
  const changed = sh("git", ["diff", "--name-only", base, head], mirror).split("\n").map((s) => s.trim()).filter(Boolean);
  const testFiles = changed.filter(isTestPath);
  const codeFiles = changed.filter((f) => !isTestPath(f));
  const goldPatch = codeFiles.length ? sh("git", ["diff", base, head, "--", ...codeFiles], mirror) : "";

  // Grading fields differ by mode:
  //   - default (suite): nothing held out — grade on the repo's own `test_cmd`
  //     run against the agent's final tree (resolved iff it exits 0).
  //   - `--hold-out`: SWE-bench — the PR's test files are held out and applied
  //     only at grade time, scored by named FAIL_TO_PASS / PASS_TO_PASS.
  let gradeFields: Partial<SweBenchInstance> = {};
  if (o.holdOut) {
    const testPatch = testFiles.length ? sh("git", ["diff", base, head, "--", ...testFiles], mirror) : "";
    if (!testFiles.length) {
      console.log(chalk.yellow("⚠ --hold-out but no test files detected in the PR diff — set test_patch by hand or rely on --test-cmd."));
    }
    let failToPass: string[] = [];
    let passToPass: string[] = ["*"];
    if (o.validate) {
      const verdicts = validate({ mirror, base, head, testPatch, testCmd: o.testCmd, setupCmd: o.setupCmd });
      failToPass = verdicts.failToPass;
      if (o.passList) passToPass = verdicts.passToPass;
      if (verdicts.note) console.log(chalk.yellow(`⚠ ${verdicts.note}`));
    } else {
      console.log(chalk.dim("Skipping validation (--no-validate) — FAIL_TO_PASS left empty."));
    }
    console.log(chalk.dim(o.passList ? "PASS_TO_PASS enumerated." : 'PASS_TO_PASS = ["*"] (whole suite must stay green; --pass-list to enumerate).'));
    gradeFields = {
      hold_out_tests: true,
      ...(testPatch ? { test_patch: testPatch } : {}),
      FAIL_TO_PASS: failToPass,
      PASS_TO_PASS: passToPass,
    };
  } else {
    console.log(chalk.dim("Suite mode (default): grade on the repo's own test_cmd at the agent's final tree — nothing held out. (--hold-out for SWE-bench style.)"));
    if (o.validate) {
      const probe = probeSuite({ mirror, base, head, testCmd: o.testCmd, setupCmd: o.setupCmd });
      if (probe.headGreen) console.log(chalk.dim("✓ Reference suite passes at head."));
      else console.log(chalk.yellow("⚠ The reference solution's suite did NOT pass at head (test_cmd exit ≠ 0) — check --test-cmd / --setup-cmd; the case may be ungradeable."));
      if (probe.baseGreen) {
        console.log(chalk.yellow("⚠ The suite is ALREADY green at base — a no-op solution would resolve this case. Consider --hold-out, or a case whose failing test already exists at base."));
      }
    }
    // No test_patch / FAIL_TO_PASS / PASS_TO_PASS — pure suite-exit-code grading.
  }

  // Issue fixture: the linked issue if the PR closes one, else the PR itself.
  // `closingIssuesReferences` carries only the issue number, so fetch title/body.
  const linkedRef = pr.closingIssuesReferences?.[0];
  const linked = linkedRef ? fetchLinkedIssue(repo, linkedRef.number) : undefined;
  if (linkedRef && !linked) {
    console.log(chalk.yellow(`⚠ PR closes #${linkedRef.number} but its title/body couldn't be read — falling back to the PR's own title/body.`));
  }
  const issueNumber = linked?.number ?? pr.number;
  const issue: IssueSeed = {
    number: issueNumber,
    title: linked?.title ?? pr.title,
    body: linked?.body ?? pr.body ?? "",
    labels: ["bug", "ready-for-agent"],
    user: "reporter",
  };

  const id = o.id ?? `codefix__${slugify(name)}-pr${pr.number}`;
  const inst: SweBenchInstance = {
    instance_id: id,
    repo,
    workflow: "build",
    base_commit: base,
    head_commit: head,
    problem_statement: linked ? `${linked.title}\n\n${linked.body ?? ""}`.trim() : `${pr.title}\n\n${pr.body ?? ""}`.trim(),
    ...(goldPatch ? { patch: goldPatch } : {}),
    ...gradeFields,
    ...(o.testCmd ? { test_cmd: o.testCmd } : {}),
    ...(o.setupCmd ? { setup_cmd: o.setupCmd } : {}),
    issue,
    expect_github: { pr_opened: { base: pr.baseRefName, head_is_branch: true } },
  };

  return emit(inst, "code-fix", "build", o);
}

/** Run the held-out tests at base (red) and head (green); diff TAP to verdicts. */
function validate(opts: { mirror: string; base: string; head: string; testPatch: string; testCmd?: string[]; setupCmd?: string[] }): {
  failToPass: string[];
  passToPass: string[];
  note?: string;
} {
  const tmp = mkdtempSync(join(tmpdir(), "ll-addcase-"));
  const wt = join(tmp, "wt");
  console.log(chalk.dim("Validating: running the repo's tests at base (red) and head (green)…"));
  try {
    sh("git", ["worktree", "add", "--quiet", "--detach", wt, opts.base], opts.mirror);
    const run = () => {
      if (opts.setupCmd) runCmd(opts.setupCmd, wt);
      const argv = opts.testCmd ?? defaultTestArgv(wt);
      return runCmd(argv, wt);
    };
    // Base + held-out tests applied → expect failures.
    if (opts.testPatch) {
      const pf = join(wt, ".eval-test.patch");
      writeFileSync(pf, opts.testPatch);
      try {
        sh("git", ["apply", pf], wt);
      } catch {
        return { failToPass: [], passToPass: [], note: "Could not apply test_patch onto base; verify FAIL_TO_PASS manually." };
      }
      rmSync(pf, { force: true });
    }
    const baseTap = parseTap(run().raw);
    // Head state already includes the tests → expect green.
    sh("git", ["checkout", "--quiet", "--force", opts.head], wt);
    const headRun = run();
    const headTap = parseTap(headRun.raw);

    if (headTap.size === 0) {
      // No TAP names → suite mode. Resolved is graded on exit code at run time.
      return {
        failToPass: [],
        passToPass: [],
        note: headRun.ok
          ? "No TAP test names parsed — case will use suite mode (graded on the test command's exit code). " +
            "For per-test FAIL_TO_PASS grading, point --test-cmd at a TAP-emitting runner (e.g. \"npx vitest run --reporter=tap\", \"npx mocha --reporter tap\")."
          : "Tests did not pass at head and emitted no TAP — check the test command / setup; case left in suite mode.",
      };
    }
    const failToPass: string[] = [];
    const passToPass: string[] = [];
    for (const [naam, greenAtHead] of headTap) {
      if (!greenAtHead) continue;
      if (baseTap.get(naam) === false || !baseTap.has(naam)) failToPass.push(naam);
      else passToPass.push(naam);
    }
    if (!failToPass.length) {
      return { failToPass, passToPass, note: "No test flipped red→green — the fix may not be exercised by these tests; review before using." };
    }
    return { failToPass, passToPass };
  } catch (err) {
    return { failToPass: [], passToPass: [], note: `Validation failed (${(err as Error).message}); fill FAIL_TO_PASS manually.` };
  } finally {
    try {
      sh("git", ["worktree", "remove", "--force", wt], opts.mirror);
    } catch {
      /* best effort */
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Suite-mode sanity probe: run the repo's own `test_cmd` at base and head. A
 * green head means the reference solution's suite passes (case is gradeable); a
 * green base means a no-op would already resolve it (the author should reconsider). */
function probeSuite(opts: { mirror: string; base: string; head: string; testCmd?: string[]; setupCmd?: string[] }): {
  baseGreen: boolean;
  headGreen: boolean;
} {
  const tmp = mkdtempSync(join(tmpdir(), "ll-addcase-suite-"));
  const wt = join(tmp, "wt");
  console.log(chalk.dim("Probing the repo suite at base and head…"));
  try {
    sh("git", ["worktree", "add", "--quiet", "--detach", wt, opts.base], opts.mirror);
    const run = () => {
      if (opts.setupCmd) runCmd(opts.setupCmd, wt);
      const argv = opts.testCmd ?? defaultTestArgv(wt);
      return runCmd(argv, wt).ok;
    };
    const baseGreen = run();
    sh("git", ["checkout", "--quiet", "--force", opts.head], wt);
    const headGreen = run();
    return { baseGreen, headGreen };
  } catch {
    return { baseGreen: false, headGreen: false };
  } finally {
    try {
      sh("git", ["worktree", "remove", "--force", wt], opts.mirror);
    } catch {
      /* best effort */
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultTestArgv(dir: string): string[] {
  const files = listTestFiles(dir);
  return [process.execPath, "--test", "--test-reporter=tap", "--experimental-strip-types", ...files];
}
function listTestFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent === "node_modules" || ent === ".git") continue;
    const rel = prefix ? `${prefix}/${ent}` : ent;
    const abs = join(dir, ent);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...listTestFiles(abs, rel));
    else if (/\.test\.(ts|tsx|mts|js|mjs)$/.test(ent)) out.push(rel);
  }
  return out;
}

// ── issue → triage case ─────────────────────────────────────────────────────

interface IssueComment {
  author?: { login?: string };
  body?: string;
}
interface IssueView {
  number: number;
  title: string;
  body: string;
  url: string;
  state?: string; // OPEN | CLOSED
  labels?: { name: string }[];
  comments?: IssueComment[];
  author?: { login?: string };
}
interface LabelEvent {
  event: string;
  label?: { name?: string };
  actor?: { login?: string };
}

/** Best-effort: who applied which label (the human triage decision). Returns a
 * net label→actor map (labels later removed are dropped). Empty if the events
 * API isn't reachable. */
function labelActors(repo: string, number: number): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const events = ghJson<LabelEvent[]>(["api", "--paginate", `repos/${repo}/issues/${number}/events`]);
    for (const e of events) {
      const ln = e.label?.name;
      if (!ln) continue;
      if (e.event === "labeled") out.set(ln, e.actor?.login ?? "?");
      else if (e.event === "unlabeled") out.delete(ln);
    }
  } catch {
    /* events API unavailable — fall back to bare label names */
  }
  return out;
}

async function fromIssue(url: string, o: Options): Promise<number> {
  const { owner, name } = parseRepoFromUrl(url);
  const repo = `${owner}/${name}`;
  const iv = ghJson<IssueView>(["issue", "view", url, "--json", "number,title,body,url,state,labels,comments,author"]);
  const labels = (iv.labels ?? []).map((l) => l.name);
  const comments = (iv.comments ?? []).filter((c) => c.body?.trim());
  const closed = (iv.state ?? "").toUpperCase() === "CLOSED";
  const issueAuthor = iv.author?.login ?? "reporter";
  const actors = labelActors(repo, iv.number);

  const id = o.id ?? `triage__${slugify(name)}-${iv.number}`;
  const inst: SweBenchInstance = {
    instance_id: id,
    repo,
    workflow: "issue-triage",
    problem_statement: `${iv.title}\n\n${iv.body ?? ""}`.trim(),
    // Seed the issue as the agent would FIRST see it: its content, but WITHOUT
    // the triage labels (those are the gold the agent must reproduce). The skill
    // can add back any genuinely pre-existing, non-triage label.
    issue: {
      number: iv.number,
      title: iv.title,
      body: iv.body ?? "",
      labels: [],
      user: issueAuthor,
    },
    // gradeTriage maps category/state to label strings — which depends on the
    // deployment's taxonomy, so the skill assigns them from `labels` below.
    triage_gold: {},
    // The human outcome to reproduce: the labels that were applied (+ closed).
    expect_github: {
      ...(labels.length ? { labels_added: labels } : {}),
      ...(closed ? { issue_closed: true } : {}),
    },
  };

  // Evidence block — the raw triage signal the skill turns into triage_gold and
  // (optionally) a comment_matches assertion.
  console.log(chalk.bold(`\n# Triage evidence for ${repo}#${iv.number}`));
  if (labels.length) {
    console.log(chalk.dim("\nLabels applied (→ split into triage_gold.category / .state):"));
    for (const l of labels) console.log(`  • ${l}${actors.has(l) ? chalk.dim(`  (by ${actors.get(l)})`) : ""}`);
  } else {
    console.log(chalk.yellow("\n⚠ No labels on the issue — no labels_added expectation; set triage_gold by hand."));
  }
  if (comments.length) {
    console.log(chalk.dim(`\nReviewer comments (${comments.length}) — use to seed context or a comment_matches regex:`));
    for (const c of comments.slice(0, 8)) {
      const who = c.author?.login ?? "?";
      const first = (c.body ?? "").trim().split("\n")[0].slice(0, 120);
      console.log(`  ${chalk.cyan(who)}: ${first}`);
    }
    if (comments.length > 8) console.log(chalk.dim(`  …and ${comments.length - 8} more`));
  }
  console.log(
    chalk.yellow(
      "\n⚠ triage_gold is empty — assign category/state from the labels above per the deployment's taxonomy before running.",
    ),
  );
  return emit(inst, "triage", "issue-triage", o);
}

// ── output ──────────────────────────────────────────────────────────────────

function emit(inst: SweBenchInstance, defaultTier: string, defaultWorkflow: string, o: Options): number {
  const tier = o.tier ?? defaultTier;
  if (o.dryRun) {
    console.log(chalk.bold(`\n# ${inst.instance_id} → ${tier}/instances.json (dry-run)\n`));
    console.log(JSON.stringify(inst, null, 2));
    return 0;
  }
  const root = resolveWriteRoot(o);
  const path = writeInstance(root, tier, defaultWorkflow, inst);
  console.log(chalk.green(`✓ wrote ${inst.instance_id} → ${path}`));
  return 0;
}

// ── entry ───────────────────────────────────────────────────────────────────

interface Options {
  tier?: string;
  id?: string;
  datasets?: string;
  overlay?: string;
  testCmd?: string[];
  setupCmd?: string[];
  holdOut: boolean;
  passList: boolean;
  validate: boolean;
  dryRun: boolean;
}

export async function runAddCase(args: string[] = []): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(ADD_CASE_USAGE);
    return 0;
  }
  const val = (name: string): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name) return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
    return undefined;
  };
  const pr = val("--pr");
  const issue = val("--issue");
  const o: Options = {
    tier: val("--tier"),
    id: val("--id"),
    datasets: val("--datasets"),
    overlay: val("--overlay"),
    testCmd: parseCmd(val("--test-cmd")),
    setupCmd: parseCmd(val("--setup-cmd")),
    holdOut: args.includes("--hold-out"),
    passList: args.includes("--pass-list"),
    validate: !args.includes("--no-validate"),
    dryRun: args.includes("--dry-run"),
  };

  if ((pr && issue) || (!pr && !issue)) {
    console.error("add-case: pass exactly one of --pr <url> or --issue <url>.\n");
    console.error(ADD_CASE_USAGE);
    return 2;
  }

  // `gh` is required for PR/issue metadata — check presence AND auth up front so
  // a missing/unauthenticated setup fails cleanly before any work, rather than
  // partway through with a raw "Command failed" from the first API call.
  try {
    sh("gh", ["--version"]);
  } catch {
    console.error("add-case needs the GitHub CLI (`gh`) on PATH. Install it from https://cli.github.com, then run `gh auth login`.");
    return 2;
  }
  try {
    sh("gh", ["auth", "status"]);
  } catch {
    console.error("add-case needs `gh` authenticated to read PRs/issues — run `gh auth login` and retry.");
    return 2;
  }

  try {
    return pr ? await fromPr(pr, o) : await fromIssue(issue!, o);
  } catch (err) {
    console.error(chalk.red(`add-case failed: ${(err as Error).message}`));
    return 1;
  }
}
