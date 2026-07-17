/**
 * Telemetry lifecycle entry point.
 *
 * `createTelemetry()` returns a {@link TelemetryHandle} the runner drives with
 * the raw Pi event stream. When telemetry is disabled (the common case) it
 * returns a cheap no-op handle and imports NO OpenTelemetry SDK — the heavy
 * `@opentelemetry/sdk-*` packages are pulled in via a dynamic `import("./sdk.js")`
 * only on the enabled path, so a default run pays ~zero cost.
 *
 * Nothing here writes to `process.stdout`/`process.stderr`: SDK diagnostics are
 * routed to the `onWarn` callback (see `sdk.ts`), preserving the library
 * contract that `run()` never touches those streams.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { TelemetryConfig } from "./config.js";
import type { SessionStatsLike } from "./mapper.js";

export type { TelemetryConfig, TelemetrySkipReason } from "./config.js";
export { resolveTelemetryConfig } from "./config.js";

export interface TelemetryHandle {
  /** Whether the OTEL pipeline is live. */
  status: "configured" | "skipped";
  /** Why it is skipped (or "init-failed" when enabled but setup threw). */
  reason?: string;
  message?: string;
  /** Feed every raw Pi session event, in order. No-op when skipped. */
  onEvent(event: AgentSessionEvent): void;
  /** Decorate the root span with terminal aggregate stats. No-op when skipped. */
  recordSessionStats(stats: SessionStatsLike): void;
  /** Mark the run as fatally errored before shutdown. No-op when skipped. */
  recordFatal(err: Error): void;
  /** Flush + shut down exporters. Always resolves; never throws. */
  shutdown(): Promise<void>;
}

export interface CreateTelemetryDeps {
  config: TelemetryConfig;
  sessionId: string;
  /** "provider/model_id" — split into gen_ai.system + gen_ai.request.model. */
  model: string;
  sandboxBackend: string;
  onWarn: (message: string) => void;
  /** Defaults to process.env; injected by tests. */
  env?: Record<string, string | undefined>;
}

function noopHandle(reason?: string, message?: string): TelemetryHandle {
  return {
    status: "skipped",
    reason,
    message,
    onEvent: () => undefined,
    recordSessionStats: () => undefined,
    recordFatal: () => undefined,
    shutdown: async () => undefined,
  };
}

/**
 * Build a telemetry handle from the resolved config. Async because the enabled
 * path dynamically imports the OTEL SDK. Initialization failures degrade to a
 * skipped handle with a warning — telemetry never breaks the run.
 */
export async function createTelemetry(deps: CreateTelemetryDeps): Promise<TelemetryHandle> {
  if (!deps.config.enabled) {
    return noopHandle(deps.config.reason);
  }
  try {
    const { startTelemetrySdk } = await import("./sdk.js");
    return startTelemetrySdk(deps);
  } catch (err) {
    const message = (err as Error).message;
    deps.onWarn(`telemetry: initialization failed (${message}); continuing without OTEL`);
    return noopHandle("init-failed", message);
  }
}
