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
import {
  loadWebSearchExtension,
  isMisconfigurationSkip as isWebSearchMisconfig,
} from "./extensions/web-search/index.js";
import { resolveModel } from "./models.js";
import { buildSandbox, type ImageDescriptor, type SandboxResult } from "./sandbox/index.js";
import { ensureImage, ImageLoaderError } from "./sandbox/images/loader.js";

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

  // GitHub extension built FIRST so the runner can mint an installation
  // token before the sandbox boots — the token is one of the env values
  // we hand to the VM. Building the extension is cheap (no LLM, no IO
  // except reading the PEM); failures surface as a warning, not an exit.
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

  // Web-search extension. Host-process execution (does not consume the
  // Gondolin egress allowlist or expose API keys to the VM). Silent skip
  // when no API key is set; warning when the user explicitly picked a
  // provider whose key is missing.
  const webSearch = loadWebSearchExtension({
    webSearch: config.webSearch,
    webSearchProvider: config.webSearchProvider,
    webSearchMaxCalls: config.webSearchMaxCalls,
  });
  if (isWebSearchMisconfig(webSearch)) {
    warn(`web-search extension disabled (${webSearch.reason}): ${webSearch.message ?? ""}`);
  } else if (webSearch.status === "configured" && webSearch.message) {
    // e.g. "multiple provider keys present; using tavily — set
    // WEB_SEARCH_PROVIDER to override". Soft warning, not a misconfig.
    warn(`web-search: ${webSearch.message}`);
  }

  // Compose the env for the sandbox VM. Order (later wins):
  //   1. Auto-injected GITHUB_TOKEN/GH_TOKEN from a minted installation
  //      token (when sandbox=gondolin AND github extension is configured).
  //   2. User-provided --sandbox-env entries.
  // App PEM is never copied into the VM — only the short-lived token.
  const sandboxEnv: Record<string, string> = {};
  if (config.sandbox === "gondolin" && github.status === "configured" && github.auth) {
    try {
      const token = await github.auth.getToken();
      sandboxEnv.GITHUB_TOKEN = token;
      sandboxEnv.GH_TOKEN = token;
    } catch (err) {
      warn(`Could not mint a GitHub installation token for sandbox env: ${(err as Error).message}`);
    }
  }
  if (config.sandboxEnv) {
    Object.assign(sandboxEnv, config.sandboxEnv);
  }

  // Resolve --sandbox-image to an absolute path + descriptor. Default
  // when --sandbox=gondolin is "default" (auto-downloaded
  // agentic-pi-dev image). Explicit "gondolin-builtin" opts out.
  let imagePath: string | undefined;
  let imageDescriptor: ImageDescriptor | undefined;
  if (config.sandbox === "gondolin") {
    const selector = config.sandboxImage ?? "default";
    try {
      const resolved = await ensureImage(selector);
      if (resolved.kind === "builtin") {
        imageDescriptor = { name: "gondolin-builtin", source: "builtin" };
      } else {
        imagePath = resolved.imagePath;
        imageDescriptor = resolved.descriptor;
      }
    } catch (err) {
      if (err instanceof ImageLoaderError) {
        // When the user didn't explicitly ask for the default image
        // (i.e. they didn't pass --sandbox-image), fall back to the
        // gondolin builtin with a warning so they still get a working
        // sandbox. If they passed --sandbox-image=default explicitly,
        // a failure there is fatal — they asked for this image.
        if (config.sandboxImage === undefined) {
          warn(`default image unavailable (${err.message}); falling back to gondolin-builtin. Hint: ${err.hint}`);
          imageDescriptor = { name: "gondolin-builtin", source: "builtin" };
        } else {
          warn(`--sandbox-image=${selector} failed: ${err.message}. Hint: ${err.hint}`);
          return 2;
        }
      } else {
        throw err;
      }
    }
  }

  // Build the sandbox backend (boots Gondolin VM if --sandbox gondolin).
  // Done eagerly so VM-boot / preflight failures surface before any tokens
  // are spent on a prompt.
  const sandboxOutcome = await buildSandbox({
    backend: config.sandbox,
    cwd: config.cwd,
    env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
    imagePath,
    image: imageDescriptor,
    allowedHttpHosts: config.allowedHttpHosts,
  });
  if (!sandboxOutcome.ok) {
    warn(`--sandbox=${sandboxOutcome.backend} failed (${sandboxOutcome.reason}): ${sandboxOutcome.hint}`);
    return 2;
  }
  const sandbox: SandboxResult = sandboxOutcome.sandbox;

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
    customTools: [...sandbox.customTools, ...github.customTools, ...webSearch.customTools],
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
  emitter.event({
    type: "extension_status",
    extension: "web-search",
    status: webSearch.status,
    reason: webSearch.reason,
    message: webSearch.message,
    provider: webSearch.provider,
    toolCount: webSearch.toolNames.length,
    maxCalls: webSearch.maxCalls,
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
