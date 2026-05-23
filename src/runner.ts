/**
 * One-shot Pi SDK runner.
 *
 * Creates an AgentSession, subscribes to events, sends one prompt, waits for
 * `agent_end`, emits a synthetic usage snapshot, and exits.
 *
 * The runner is sink-agnostic: events flow through an `Emitter` whose sink
 * is provided by the caller. The CLI passes a `StdoutSink`; the
 * programmatic `run()` API passes a `CollectorSink`. Warnings flow through
 * an `onWarn` callback for the same reason — so library consumers never
 * see `process.stderr` writes they didn't ask for.
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { RunConfig } from "./args.js";
import { Emitter, type EmitterSink } from "./emitter.js";
import { loadGitHubExtension, isMisconfigurationSkip } from "./extensions/github/index.js";
import { resolveModel } from "./models.js";
import { buildSandbox, type SandboxResult } from "./sandbox/index.js";

export interface RunOnceDeps {
  /** Sink for all JSONL records. Required. */
  sink: EmitterSink;
  /** Called with human-readable warning text. Default: no-op. */
  onWarn?: (message: string) => void;
}

export type RunOnceExitCode = 0 | 1 | 2;

export async function runOnce(
  config: RunConfig,
  prompt: string,
  deps: RunOnceDeps,
): Promise<RunOnceExitCode> {
  const warn = deps.onWarn ?? (() => undefined);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = resolveModel(config.model, modelRegistry);

  const sessionManager = buildSessionManager(config);

  // Build the sandbox backend (boots Gondolin VM if --sandbox gondolin).
  // Done eagerly so VM-boot / preflight failures surface before any tokens
  // are spent on a prompt.
  const sandboxOutcome = await buildSandbox({ backend: config.sandbox, cwd: config.cwd });
  if (!sandboxOutcome.ok) {
    warn(`--sandbox=${sandboxOutcome.backend} failed (${sandboxOutcome.reason}): ${sandboxOutcome.hint}`);
    return 2;
  }
  const sandbox: SandboxResult = sandboxOutcome.sandbox;

  // Build the GitHub extension up-front so we can surface auth issues before
  // creating the session (rather than at first tool call).
  const github = loadGitHubExtension(config.profile);

  // Loud about misconfigurations (partial App creds, unreadable PEM) — the
  // user almost certainly meant for GitHub to work. Silent about benign
  // skips (no --profile, no creds at all).
  if (isMisconfigurationSkip(github)) {
    warn(`GitHub extension disabled (${github.reason}): ${github.message ?? ""}`);
  } else if (
    github.status === "skipped" &&
    github.reason === "no-credentials" &&
    config.profile
  ) {
    warn(`--profile=${config.profile} set but no GITHUB_APP_* or GITHUB_TOKEN env vars found; GitHub tools disabled`);
  }

  // When a sandbox is active it supplies its own read/write/edit/bash that
  // route through the VM; Pi's host built-ins of the same names must be
  // suppressed so they don't shadow ours.
  const noToolsMode =
    config.noBuiltinTools ? "builtin" :
    sandbox.suppressBuiltins ? "builtin" :
    undefined;

  const { session } = await createAgentSession({
    cwd: config.cwd,
    model,
    thinkingLevel: config.thinking,
    sessionManager,
    authStorage,
    modelRegistry,
    tools: config.tools,
    noTools: noToolsMode,
    customTools: [...sandbox.customTools, ...github.customTools],
  });

  const emitter = new Emitter(
    {
      sessionId: session.sessionId,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
    },
    deps.sink,
  );

  emitter.sessionHeader();
  emitter.event({
    type: "sandbox_status",
    backend: sandbox.backend,
    status: sandbox.status,
  });
  emitter.event({
    type: "extension_status",
    extension: "github",
    status: github.status,
    reason: github.reason,
    message: github.message,
    profile: github.profile,
    toolCount: github.toolNames.length,
  });

  let sawError = false;
  let agentEndSeen = false;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    emitter.event(event as unknown as Record<string, unknown> & { type: string });

    if (event.type === "tool_execution_end" && event.isError) {
      sawError = true;
    }
    if (event.type === "agent_end") {
      agentEndSeen = true;
    }
  });

  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
  } catch (err) {
    emitter.event({
      type: "fatal_error",
      error: { name: (err as Error).name, message: (err as Error).message },
    });
    unsubscribe();
    session.dispose();
    await sandbox.close();
    return 1;
  }

  // Synthesize a usage snapshot from the session stats. Pi's event stream
  // does not carry per-event token/cost; lastlight reads this terminal event.
  try {
    const stats = session.getSessionStats();
    emitter.event({
      type: "usage_snapshot",
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        tokens: stats.tokens,
        cost: stats.cost,
      },
    });
  } catch (err) {
    emitter.event({
      type: "usage_snapshot_error",
      error: { message: (err as Error).message },
    });
  }

  unsubscribe();
  session.dispose();
  await sandbox.close();

  if (sawError && !agentEndSeen) return 1;
  return 0;
}

function buildSessionManager(config: RunConfig): SessionManager {
  if (config.noSession) {
    return SessionManager.inMemory(config.cwd);
  }
  return SessionManager.create(config.cwd, config.sessionDir);
}
