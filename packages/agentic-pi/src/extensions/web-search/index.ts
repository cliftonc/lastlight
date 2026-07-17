/**
 * Web-search extension entry point.
 *
 * Mirrors `src/extensions/github/index.ts`:
 *   - silent skip when no provider is selected / no key present
 *   - loud (warning-worthy) skip when the user explicitly asked for a
 *     provider but didn't supply its key, or set an unknown name
 *   - on success, hands a typed customTools list back to the runner
 *
 * Selection logic lives in `selection.ts`; this module wires the chosen
 * provider to its tool builder and a per-run RateLimiter.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createBraveProvider } from "./providers/brave.js";
import { createExaProvider } from "./providers/exa.js";
import { createTavilyProvider } from "./providers/tavily.js";
import { RateLimiter } from "./rate-limit.js";
import { selectProvider, type SelectionInput } from "./selection.js";
import { buildWebSearchTools } from "./tools.js";
import type { Provider, ProviderName, WebSearchSkipReason } from "./types.js";

export const DEFAULT_MAX_CALLS = 30;

export interface WebSearchExtensionConfig {
  /** When false, the extension is force-skipped (disabled-by-flag). Default: true. */
  webSearch?: boolean;
  /** Explicit provider override. */
  webSearchProvider?: string;
  /** Per-run call budget shared across web_search + web_fetch. Default: 30. */
  webSearchMaxCalls?: number;
  /** Env override (defaults to process.env). Injected by tests. */
  env?: Record<string, string | undefined>;
}

export interface WebSearchExtensionResult {
  /** Tools to merge into createAgentSession({ customTools }). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customTools: ToolDefinition<any>[];
  toolNames: string[];
  status: "configured" | "skipped";
  reason?: WebSearchSkipReason;
  message?: string;
  provider?: ProviderName;
  /** The cap actually enforced (echoed for observability). */
  maxCalls?: number;
}

export function loadWebSearchExtension(
  config: WebSearchExtensionConfig = {},
): WebSearchExtensionResult {
  const env = config.env ?? (process.env as Record<string, string | undefined>);
  const input: SelectionInput = {
    webSearch: config.webSearch ?? true,
    webSearchProvider: config.webSearchProvider,
    env,
  };

  const selection = selectProvider(input);
  if (selection.status === "skipped") {
    return {
      customTools: [],
      toolNames: [],
      status: "skipped",
      reason: selection.reason,
      message: selection.message,
      provider: selection.provider,
    };
  }

  const provider = instantiateProvider(selection.provider, selection.apiKey);
  const maxCalls = clampMaxCalls(config.webSearchMaxCalls);
  const limiter = new RateLimiter(maxCalls);
  const tools = buildWebSearchTools(provider, limiter);

  return {
    customTools: tools,
    toolNames: tools.map((t) => t.name),
    status: "configured",
    provider: selection.provider,
    message: selection.message,
    maxCalls,
  };
}

/**
 * True if the skip is something the user almost certainly wants surfaced
 * as a warning (vs. the silent "no keys set" case).
 */
export function isMisconfigurationSkip(result: WebSearchExtensionResult): boolean {
  if (result.status !== "skipped") return false;
  if (result.reason === "invalid-config") return true;
  // Explicit provider asked for, but no key — louder than the generic
  // "no creds at all" skip.
  if (result.reason === "no-credentials" && result.provider !== undefined) return true;
  return false;
}

function instantiateProvider(name: ProviderName, apiKey: string): Provider {
  switch (name) {
    case "tavily":
      return createTavilyProvider({ apiKey });
    case "brave":
      return createBraveProvider({ apiKey });
    case "exa":
      return createExaProvider({ apiKey });
  }
}

function clampMaxCalls(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_MAX_CALLS;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > 1000) return 1000;
  return n;
}

export type { ProviderName, WebSearchSkipReason } from "./types.js";
