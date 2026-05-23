/**
 * Programmatic entry point.
 *
 * Use this when calling agentic-pi in-process from a Node host (e.g.
 * lastlight). It returns a fully-resolved `RunResult` carrying the same
 * information lastlight's `opencode-executor` needs from the JSONL stream
 * (sessionId, finalText, tokens, cost, sandbox + GitHub status, etc.)
 * plus the raw event records so the caller can do anything else they want
 * with them.
 *
 * Never writes to `process.stdout` or `process.stderr`. Hand it an
 * `onEvent` and/or `onWarn` callback if you want to observe live.
 */

import type { RunConfig } from "./args.js";

/**
 * Pi thinking level. Matches Pi's `thinkingLevel` enum. Kept as a local
 * string-union rather than imported from `@earendil-works/pi-agent-core`
 * (which is a transitive dep we don't import directly — see AGENTS.md
 * hard rule #3).
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
import {
  CollectorSink,
  TeeSink,
  type EmitterRecord,
  type EmitterSink,
} from "./emitter.js";
import { runOnce, type RunOnceExitCode } from "./runner.js";

export interface RunOptions {
  // ── Required ────────────────────────────────────────────────────
  /** "provider/model_id", e.g. "anthropic/claude-haiku-4-5". */
  model: string;
  /** The prompt to send to the agent. */
  prompt: string;

  // ── Optional, mirror the CLI flags ──────────────────────────────
  /** Pi thinking level. */
  thinking?: ThinkingLevel;
  /** GitHub profile: "read" | "issues-write" | "review-write" | "repo-write". */
  profile?: string;
  /** Sandbox backend. Default: "none". */
  sandbox?: "none" | "gondolin";
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Skip session persistence. Default: false. */
  noSession?: boolean;
  /** Override session storage directory. */
  sessionDir?: string;
  /** Disable Pi's built-in tools (read/write/edit/bash/grep/find/ls). */
  noBuiltinTools?: boolean;
  /** Explicit tool allowlist. */
  tools?: string[];

  // ── Observability hooks ─────────────────────────────────────────
  /**
   * Called for every emitted JSONL record in order. Same shape that the
   * CLI writes to stdout, with `sessionId` and `timestamp` already injected.
   * Use this to mirror events into your own jsonl file, push deltas to a
   * UI, or persist sessionId early.
   */
  onEvent?: (record: EmitterRecord) => void;

  /**
   * Called for human-readable warnings (e.g. partial GitHub creds). The
   * CLI writes these to stderr; in-process callers usually want to log
   * them somewhere structured.
   */
  onWarn?: (message: string) => void;

  /**
   * Extra sink to fan records out to (in addition to the internal
   * collector that powers `result.records`). Useful if you want to write
   * the shim jsonl directly without buffering through onEvent.
   */
  extraSink?: EmitterSink;
}

/** Outcome of one agentic-pi run. */
export interface RunResult {
  /** Exit code the CLI would have returned (0 = ok, 1 = runtime error, 2 = config error). */
  exitCode: RunOnceExitCode;
  /** True iff `exitCode === 0`. */
  ok: boolean;
  /** True iff Pi emitted an `agent_end` (clean termination). */
  agentEnded: boolean;
  /** True iff at least one tool returned an error. */
  toolErrors: boolean;
  /** If a fatal error short-circuited the run, this is set. */
  fatalError?: { name: string; message: string };

  /** Pi session id (from the session header line). May be undefined if preflight failed. */
  sessionId?: string;
  /** cwd the agent ran in. */
  cwd?: string;
  /** ISO timestamp of session start. */
  startedAt?: string;

  /** Concatenated final assistant text (the agent's "answer"). */
  finalText: string;
  /** Full message array from `agent_end` (user + assistant + toolResult messages). */
  messages: unknown[];

  /** Stats from the synthesized `usage_snapshot` event. */
  stats?: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
  };

  /** Mirrors of the `sandbox_status` and `extension_status` lines. */
  sandbox?: { backend: string; status: Record<string, unknown> };
  github?: {
    status: "configured" | "skipped";
    reason?: string;
    message?: string;
    profile?: string;
    toolCount: number;
  };

  /** Every JSONL record the run emitted, in order. */
  records: EmitterRecord[];
  /** Warnings that would have gone to stderr in CLI mode. */
  warnings: string[];
}

/**
 * Run agentic-pi in-process and return a fully-derived result.
 *
 * @example
 * ```ts
 * import { run } from "agentic-pi";
 *
 * const result = await run({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "list the open PRs on owner/repo",
 *   profile: "read",
 *   noSession: true,
 * });
 *
 * console.log(result.finalText);
 * console.log(result.stats?.cost, "USD");
 * ```
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const config: RunConfig = {
    model: options.model,
    thinking: options.thinking,
    profile: options.profile,
    cwd: options.cwd ?? process.cwd(),
    noSession: options.noSession ?? false,
    sessionDir: options.sessionDir,
    noBuiltinTools: options.noBuiltinTools ?? false,
    tools: options.tools,
    dangerouslySkipPermissions: false,
    sandbox: options.sandbox ?? "none",
  };

  const collector = new CollectorSink(options.onEvent);
  const sink: EmitterSink = options.extraSink
    ? new TeeSink([collector, options.extraSink])
    : collector;

  const warnings: string[] = [];
  const onWarn = (msg: string) => {
    warnings.push(msg);
    options.onWarn?.(msg);
  };

  const exitCode = await runOnce(config, options.prompt, { sink, onWarn });

  return buildResult(exitCode, collector.records, warnings);
}

function buildResult(
  exitCode: RunOnceExitCode,
  records: EmitterRecord[],
  warnings: string[],
): RunResult {
  const result: RunResult = {
    exitCode,
    ok: exitCode === 0,
    agentEnded: false,
    toolErrors: false,
    finalText: "",
    messages: [],
    records,
    warnings,
  };

  for (const r of records) {
    switch (r.type) {
      case "session":
        result.sessionId = r.id as string;
        result.cwd = r.cwd as string;
        result.startedAt = r.timestamp as string;
        break;

      case "sandbox_status":
        result.sandbox = {
          backend: r.backend as string,
          status: (r.status as Record<string, unknown>) ?? {},
        };
        break;

      case "extension_status":
        if (r.extension === "github") {
          result.github = {
            status: r.status as "configured" | "skipped",
            reason: r.reason as string | undefined,
            message: r.message as string | undefined,
            profile: r.profile as string | undefined,
            toolCount: (r.toolCount as number) ?? 0,
          };
        }
        break;

      case "message_end": {
        // Accumulate assistant text. Pi's message structure:
        // r.message = { role: "assistant", content: [{type:"text", text:"…"}, ...] }
        const m = r.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          // Keep only the LATEST assistant text (final answer overwrites
          // intermediate ones). Pi guarantees the last assistant message
          // before agent_end is the final answer.
          const text = m.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) result.finalText = text;
        }
        break;
      }

      case "tool_execution_end":
        if (r.isError === true) result.toolErrors = true;
        break;

      case "agent_end":
        result.agentEnded = true;
        if (Array.isArray(r.messages)) {
          result.messages = r.messages as unknown[];
        }
        break;

      case "usage_snapshot":
        result.stats = r.stats as RunResult["stats"];
        break;

      case "fatal_error":
        result.fatalError = r.error as { name: string; message: string };
        break;
    }
  }

  return result;
}
