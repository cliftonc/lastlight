/**
 * `lastlight-evals clean` — finalize eval runs that were killed or crashed
 * mid-flight. Such runs stay frozen in the dashboard as "running" because their
 * scorecard kept `live: true` (the final write never happened). This finds runs
 * that are still `live` but whose heartbeat has gone stale (the writing process
 * is gone) and either marks them interrupted (default — keeps the partial
 * scorecard, cost, and transcripts for inspection) or removes the run dir
 * (`--delete`).
 *
 * The same staleness rule drives the dashboard (see `indexRun` /
 * `heartbeatFresh`), so `clean` only ever touches runs the dashboard already
 * shows as interrupted — never a genuinely live one.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import chalk from "chalk";

import { resultsRoot } from "./paths.js";
import { writeScorecard, heartbeatFresh, type Scorecard } from "./report.js";

const CLEAN_USAGE = `lastlight-evals clean [options]

Finalize eval runs killed or crashed mid-flight (stuck showing "running" in the
dashboard). A run is "dead" when its scorecard is still \`live\` but its heartbeat
has gone stale — the process that was writing it is gone.

Options:
  --delete             Remove the run directory instead of marking it interrupted
  --older-than <dur>   Only clean runs older than this (e.g. 30m, 2h, 1d)
  --dry-run            List what would change; write nothing
  -h, --help           Show this help`;

interface DeadRun {
  tierKey: string;
  /** Run subdir name, or "" for a legacy flat run sitting in the tier dir. */
  dir: string;
  /** Directory holding this run's scorecard.json. */
  path: string;
  card: Scorecard;
  generatedAt: string;
  progress?: string;
}

/** Parse `30m` / `2h` / `1d` / `45s` into ms; undefined if unset, null if bad. */
function parseDuration(s: string | undefined): number | null | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const unit: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
  return Number(m[1]) * unit[m[2].toLowerCase()];
}

function parseCard(file: string): Scorecard | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Scorecard;
  } catch {
    return null; // half-written / malformed — skip
  }
}

/** Find every run that is `live` on disk but whose heartbeat is stale/absent. */
function findDeadRuns(root: string, nowMs: number): DeadRun[] {
  const out: DeadRun[] = [];
  if (!existsSync(root)) return out;
  const consider = (tierKey: string, dir: string, cardDir: string) => {
    const card = parseCard(join(cardDir, "scorecard.json"));
    const meta = card?.meta;
    if (!card || !meta?.live) return; // only in-flight runs
    if (heartbeatFresh(meta.heartbeat, nowMs)) return; // genuinely alive
    out.push({ tierKey, dir, path: cardDir, card, generatedAt: meta.generatedAt ?? "", progress: meta.progress });
  };
  for (const tier of readdirSync(root, { withFileTypes: true })) {
    if (!tier.isDirectory()) continue;
    const tierDir = join(root, tier.name);
    for (const ent of readdirSync(tierDir, { withFileTypes: true })) {
      if (ent.isDirectory()) consider(tier.name, ent.name, join(tierDir, ent.name));
    }
    consider(tier.name, "", tierDir); // legacy flat run
  }
  return out;
}

export async function runClean(args: string[] = []): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(CLEAN_USAGE);
    return 0;
  }
  const del = args.includes("--delete");
  const dryRun = args.includes("--dry-run");
  const i = args.indexOf("--older-than");
  const olderThanMs = parseDuration(i >= 0 ? args[i + 1] : undefined);
  if (olderThanMs === null) {
    console.error(`clean: bad --older-than "${args[i + 1]}" (use e.g. 30m, 2h, 1d).`);
    return 2;
  }

  const root = resultsRoot();
  const nowMs = Date.now();
  let dead = findDeadRuns(root, nowMs);
  if (olderThanMs !== undefined) {
    dead = dead.filter((r) => {
      const t = Date.parse(r.generatedAt);
      // Unparseable timestamp ⇒ treat as old enough to clean.
      return Number.isFinite(t) ? nowMs - t >= olderThanMs : true;
    });
  }

  if (!dead.length) {
    console.log(chalk.green("No interrupted runs to clean — every live run has a fresh heartbeat."));
    return 0;
  }

  const verb = del ? "delete" : "mark interrupted";
  console.log(chalk.bold(`${dryRun ? "Would " : ""}${verb} ${dead.length} interrupted run(s):`));
  for (const r of dead) {
    const label = `${r.tierKey}/${r.dir || "(flat run)"}`;
    console.log(`  • ${label}  ${chalk.dim(`${r.generatedAt}  ${r.progress ?? ""}`)}`);
    if (dryRun) continue;
    // Never `rm` a legacy flat run's dir — it IS the tier dir and would take
    // sibling runs with it. Mark those interrupted instead.
    if (del && r.dir) {
      rmSync(r.path, { recursive: true, force: true });
    } else {
      const card = r.card;
      card.meta = { ...card.meta!, live: false, interrupted: true, pending: [] };
      writeScorecard(r.path, card);
      if (del && !r.dir) console.log(chalk.dim("    (flat run — marked interrupted rather than deleting the tier dir)"));
    }
  }
  if (dryRun) console.log(chalk.dim("\n(dry-run — nothing written. Re-run without --dry-run to apply.)"));
  else console.log(chalk.green(`\n✓ ${del ? "removed" : "finalized"} ${dead.length} run(s).`));
  return 0;
}
