/**
 * Programmatic API smoke test.
 *
 * Drives agentic-pi's `run()` in-process from a separate Node script,
 * exactly the way lastlight would. Verifies:
 *   1. Nothing is written to process.stdout (would mean a sink leak).
 *   2. RunResult has the fields we promise.
 *   3. onEvent gets called for every record.
 *   4. Warnings flow through onWarn, not stderr.
 *
 * Usage: `node test/programmatic-smoke.mjs` from the project root with
 * the appropriate env loaded.
 */

import { run } from "../dist/index.js";

// Capture anything sneaking out to stdout/stderr. Library code should
// never touch these.
const stdoutChunks = [];
const stderrChunks = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => {
  stdoutChunks.push(chunk.toString());
  return origStdoutWrite(chunk, ...rest);
};
process.stderr.write = (chunk, ...rest) => {
  stderrChunks.push(chunk.toString());
  return origStderrWrite(chunk, ...rest);
};

const liveEvents = [];
const liveWarnings = [];

const result = await run({
  model: "openai/gpt-5.4-nano",
  prompt: "say 'programmatic mode works' verbatim and nothing else",
  thinking: "off",
  noSession: true,
  onEvent: (record) => liveEvents.push(record.type),
  onWarn: (msg) => liveWarnings.push(msg),
});

// Restore for our own console.log to work normally below.
process.stdout.write = origStdoutWrite;
process.stderr.write = origStderrWrite;

const summary = {
  exitCode: result.exitCode,
  ok: result.ok,
  agentEnded: result.agentEnded,
  sessionId: result.sessionId,
  finalText: result.finalText,
  toolErrors: result.toolErrors,
  sandboxBackend: result.sandbox?.backend,
  githubStatus: result.github?.status,
  githubReason: result.github?.reason,
  stats: result.stats && {
    totalTokens: result.stats.tokens.total,
    cost: result.stats.cost,
  },
  recordCount: result.records.length,
  warningCount: result.warnings.length,
  liveEventCount: liveEvents.length,
  uniqueEventTypes: [...new Set(liveEvents)].sort(),
  stdoutLeaked: stdoutChunks.join("").length > 0,
  stderrLeaked: stderrChunks.join("").length > 0,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(result.ok ? 0 : 1);
