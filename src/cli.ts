#!/usr/bin/env node

/**
 * Last Light CLI — thin client that triggers the server.
 *
 * Usage:
 *   npx tsx src/cli.ts https://github.com/owner/repo/issues/42
 *   npx tsx src/cli.ts owner/repo#42
 *   npx tsx src/cli.ts triage owner/repo
 *   npx tsx src/cli.ts review owner/repo
 *   npx tsx src/cli.ts health owner/repo
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
  tsx src/cli.ts <github-url>          Trigger build cycle for an issue/PR
  tsx src/cli.ts <owner/repo#number>   Same, shorthand
  tsx src/cli.ts triage <owner/repo>   Run issue triage
  tsx src/cli.ts review <owner/repo>   Run PR review scan
  tsx src/cli.ts health <owner/repo>   Run health report

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

  // ── Skill commands: triage, review, health ──────────────────────

  if (["triage", "review", "health"].includes(firstArg)) {
    const repoArg = args[1];
    if (!repoArg) {
      console.error(`Usage: tsx src/cli.ts ${firstArg} <owner/repo>`);
      process.exit(1);
    }

    const skillMap: Record<string, string> = {
      triage: "issue-triage",
      review: "pr-review",
      health: "repo-health",
    };

    console.log(`Triggering ${firstArg} on ${repoArg}...`);

    const res = await fetch(`${SERVER_URL}/api/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        skill: skillMap[firstArg],
        context: { repos: [repoArg], mode: "scan" },
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
    return;
  }

  // ── GitHub URL or shorthand: trigger build cycle ───────────────

  const parsed = parseGitHubRef(firstArg);
  if (!parsed) {
    console.error(`Could not parse GitHub reference: ${firstArg}`);
    console.error(`Expected: https://github.com/owner/repo/issues/N or owner/repo#N`);
    process.exit(1);
  }

  const { owner, repo, number } = parsed;
  console.log(`Triggering build cycle for ${owner}/${repo}#${number}...`);

  const res = await fetch(`${SERVER_URL}/api/build`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      owner,
      repo,
      issueNumber: number,
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
