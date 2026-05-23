/**
 * Programmatic API + sandbox smoke test.
 *
 * Exercises the full path lastlight would take when wanting per-task VM
 * isolation: import run(), pass --sandbox gondolin, get a structured
 * result, and confirm the side effect (file written via the agent's
 * VM-routed `write` tool) lands on the host.
 */

import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { run } from "../dist/index.js";

const workspace = "/tmp/agentic-pi-programmatic-sandbox-smoke";
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

const result = await run({
  model: "openai/gpt-5.4-nano",
  prompt: "use the write tool to create a file called report.md containing exactly the text 'sandbox+programmatic ok'",
  thinking: "off",
  noSession: true,
  sandbox: "gondolin",
  cwd: workspace,
});

const reportPath = `${workspace}/report.md`;
const fileExists = existsSync(reportPath);
const fileContent = fileExists ? readFileSync(reportPath, "utf8") : null;

console.log(JSON.stringify({
  exitCode: result.exitCode,
  ok: result.ok,
  agentEnded: result.agentEnded,
  finalText: result.finalText,
  sandboxBackend: result.sandbox?.backend,
  vmCreateMs: result.sandbox?.status?.createMs,
  toolsCalled: [...new Set(
    result.records
      .filter((r) => r.type === "tool_execution_start")
      .map((r) => r.toolName),
  )],
  hostFileExists: fileExists,
  hostFileContent: fileContent?.trim(),
  cost: result.stats?.cost,
}, null, 2));

process.exit(result.ok && fileExists ? 0 : 1);
