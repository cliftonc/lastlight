#!/usr/bin/env node

/**
 * Last Light CLI — thin client that triggers the server.
 *
 * Usage:
 *   npx tsx src/cli.ts <github-url>            Triage that issue (default — cheap)
 *   npx tsx src/cli.ts <owner/repo#number>     Same, shorthand
 *   npx tsx src/cli.ts triage <owner/repo>     Scan repo for issues to triage
 *   npx tsx src/cli.ts review <owner/repo>     Scan repo for PRs to review
 *   npx tsx src/cli.ts health <owner/repo>     Generate weekly health report
 *   npx tsx src/cli.ts build <github-url>      Run FULL build cycle (architect/executor/reviewer/PR)
 *   npx tsx src/cli.ts build <owner/repo#N>    Same, shorthand
 *
 * The default action for a single-issue reference is now TRIAGE, not build.
 * Build cycles are expensive (multiple agent phases, may create PRs) so they
 * require an explicit `build` subcommand to opt in.
 *
 * The CLI does NOT run agents directly — it POSTs to the running server.
 * Start the server first: npm run dev
 */

const SERVER_URL = process.env.LASTLIGHT_URL || "http://localhost:8644";
let AUTH_TOKEN = process.env.LASTLIGHT_TOKEN || "";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Last Light CLI

Usage:
  tsx src/cli.ts setup                 Interactive setup wizard (run before first launch)
  tsx src/cli.ts <github-url>          Triage that one issue (default — cheap)
  tsx src/cli.ts <owner/repo#number>   Same, shorthand
  tsx src/cli.ts triage <owner/repo>   Scan repo for issues to triage
  tsx src/cli.ts review <owner/repo>   Scan repo for PRs to review
  tsx src/cli.ts health <owner/repo>   Generate weekly health report
  tsx src/cli.ts build <github-url>    Run FULL build cycle (architect/executor/reviewer/PR)
  tsx src/cli.ts build <owner/repo#N>  Same, shorthand

The default for a single issue reference is now TRIAGE, not build.
Build cycles are expensive — opt in explicitly with the \`build\` subcommand.

The server must be running (npm run dev). Set LASTLIGHT_URL to override.
`);
  process.exit(0);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  return headers;
}

async function authenticate(): Promise<void> {
  // If we already have a token, verify it works
  if (AUTH_TOKEN) return;

  // Try to login with ADMIN_PASSWORD
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return; // No auth configured

  try {
    const res = await fetch(`${SERVER_URL}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const { token } = await res.json() as { token: string };
      AUTH_TOKEN = token;
    }
  } catch {
    // Auth may not be required — continue without token
  }
}

async function main() {
  // Setup wizard — runs before server health check (no server needed)
  if (args[0] === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    process.exit(0);
  }

  // Check server is running
  try {
    const healthRes = await fetch(`${SERVER_URL}/health`);
    if (!healthRes.ok) throw new Error();
  } catch {
    console.error(`Server not running at ${SERVER_URL}`);
    console.error(`Start it first: npm run dev`);
    process.exit(1);
  }

  // Authenticate if needed
  await authenticate();

  const firstArg = args[0];

  // ── Explicit `build` subcommand: trigger the full build cycle ──────────
  // This is the only path that hits /api/build and runs architect → executor →
  // reviewer → PR. Build cycles are expensive and may create PRs, so opt-in.

  if (firstArg === "build") {
    const target = args[1];
    if (!target) {
      console.error(`Usage: tsx src/cli.ts build <github-url> | <owner/repo#N>`);
      process.exit(1);
    }
    const parsed = parseGitHubRef(target);
    if (!parsed) {
      console.error(`Could not parse GitHub reference: ${target}`);
      console.error(`Expected: https://github.com/owner/repo/issues/N or owner/repo#N`);
      process.exit(1);
    }
    const { owner, repo, number } = parsed;
    console.log(`Triggering BUILD cycle for ${owner}/${repo}#${number}...`);
    const res = await fetch(`${SERVER_URL}/api/build`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ owner, repo, issueNumber: number }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`Accepted: ${JSON.stringify(data)}`);
      console.log(`Check server logs for progress.`);
    } else {
      console.error(`Failed: ${JSON.stringify(data)}`);
      process.exit(1);
    }
    return;
  }

  // ── Skill commands: triage, review, health ─────────────────────────────
  // `triage` and `review` accept either:
  //   - <owner/repo>   → repo-wide scan (existing behavior)
  //   - <owner/repo#N> → single-issue / single-PR action
  // `health` only takes a repo (it's always a repo-level report).

  if (["triage", "review", "health", "security"].includes(firstArg)) {
    const target = args[1];
    if (!target) {
      console.error(`Usage: tsx src/cli.ts ${firstArg} <owner/repo>${firstArg !== "health" && firstArg !== "security" ? " | <owner/repo#N>" : ""}`);
      process.exit(1);
    }

    const skillMap: Record<string, string> = {
      triage: "issue-triage",
      review: "pr-review",
      health: "repo-health",
      security: "security-review",
    };
    const skill = skillMap[firstArg];

    // Detect single-issue/PR form (allowed for triage and review only)
    const parsed = firstArg !== "health" && firstArg !== "security" ? parseGitHubRef(target) : null;

    let context: Record<string, unknown>;
    if (parsed) {
      const { owner, repo, number } = parsed;
      context = {
        repo: `${owner}/${repo}`,
        issueNumber: number,
        sender: "cli",
      };
      console.log(`Triggering ${firstArg} on ${owner}/${repo}#${number}...`);
    } else {
      context = { repos: [target], mode: "scan" };
      console.log(`Triggering ${firstArg} scan on ${target}...`);
    }

    const res = await fetch(`${SERVER_URL}/api/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ skill, context }),
    });

    const data = await res.json();
    if (res.ok) {
      console.log(`Accepted: ${JSON.stringify(data)}`);
      console.log(`Check server logs for progress.`);
    } else {
      console.error(`Failed: ${JSON.stringify(data)}`);
      process.exit(1);
    }
    return;
  }

  // ── Default: shorthand <github-url> or <owner/repo#N> → triage that issue
  //
  // This is intentionally cheap. To run a full build cycle, use `build <ref>`.

  const parsed = parseGitHubRef(firstArg);
  if (!parsed) {
    console.error(`Could not parse GitHub reference: ${firstArg}`);
    console.error(`Expected: https://github.com/owner/repo/issues/N or owner/repo#N`);
    console.error(``);
    console.error(`To trigger a full build cycle, use: tsx src/cli.ts build ${firstArg}`);
    process.exit(1);
  }

  const { owner, repo, number, type } = parsed;
  const isPr = type === "pr";
  const skill = isPr ? "pr-review" : "issue-triage";
  const action = isPr ? "PR review" : "issue triage";

  console.log(`Triggering ${action} for ${owner}/${repo}#${number}...`);
  console.log(`(For a full build cycle: tsx src/cli.ts build ${owner}/${repo}#${number})`);

  const res = await fetch(`${SERVER_URL}/api/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      skill,
      context: {
        repo: `${owner}/${repo}`,
        ...(isPr ? { prNumber: number } : { issueNumber: number }),
        sender: "cli",
      },
    }),
  });

  const data = await res.json();
  if (res.ok) {
    console.log(`Accepted: ${JSON.stringify(data)}`);
    console.log(`Check server logs for progress.`);
  } else {
    console.error(`Failed: ${JSON.stringify(data)}`);
    process.exit(1);
  }
}

// ── GitHub reference parser ─────────────────────────────────────────

function parseGitHubRef(input: string) {
  // Full URL: https://github.com/owner/repo/issues/42
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: parseInt(urlMatch[4], 10),
      type: urlMatch[3] === "pull" ? "pr" : "issue",
    };
  }

  // Shorthand: owner/repo#42
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      number: parseInt(shortMatch[3], 10),
      type: "issue",
    };
  }

  return null;
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
