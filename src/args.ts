/**
 * Argument parsing for `agentic-pi run`.
 *
 * Modeled loosely on opencode's CLI surface so the swap inside a Docker
 * sandbox is one line. We intentionally do NOT mimic opencode's JSON event
 * shape — see the plan doc for why.
 */

export interface RunConfig {
  /** "provider/model_id", e.g. "anthropic/claude-haiku-4-5" */
  model: string;
  /** Pi thinking level. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** GitHub tool profile. Phase 2 will use this. */
  profile?: string;
  /** Working directory for the agent. Default: process.cwd(). */
  cwd: string;
  /** Whether to persist the session to disk. Default: true (Pi's default). */
  noSession: boolean;
  /** Optional override for session storage directory. */
  sessionDir?: string;
  /** Disable built-in tools (read/write/edit/bash/grep/find/ls). */
  noBuiltinTools: boolean;
  /** Explicit tool allowlist (comma-separated). */
  tools?: string[];
  /** Ignored — accepted for opencode call-site compatibility. */
  dangerouslySkipPermissions: boolean;
  /** Sandbox backend for read/write/edit/bash. */
  sandbox: "none" | "gondolin";
  /**
   * Image to boot when `sandbox === "gondolin"`. Resolved by the image
   * loader:
   *   - `"default"` → bundled `agentic-pi-dev` manifest (auto-downloaded).
   *   - `"gondolin-builtin"` → gondolin's built-in `alpine-base:latest`.
   *   - absolute path → a local `gondolin build` output directory.
   * Ignored when `sandbox === "none"`. Default: `"default"`.
   */
  sandboxImage?: string;
  /**
   * Environment variables to inject into the sandbox VM. Ignored when
   * sandbox === "none" (Pi's host tools already inherit process.env).
   * Use this to hand `GITHUB_TOKEN`, secrets, or workflow context to the
   * agent's `bash` calls inside the VM.
   *
   * Set via `--sandbox-env KEY=VAL` (repeatable). When `--profile` is
   * active and the GitHub extension is configured, a short-lived
   * installation token is auto-injected as both `GITHUB_TOKEN` and
   * `GH_TOKEN`. User-provided values override the auto-injected ones.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * HTTP egress allowlist for the sandbox VM. Without this, gondolin
   * returns 502 to every outbound request from inside the VM —
   * `git clone`, `git push`, `gh api`, `npm install`, `pip install` all
   * fail. Default: a built-in GitHub-only list (github.com,
   * api.github.com, codeload.github.com, objects.githubusercontent.com,
   * raw.githubusercontent.com).
   *
   * Set explicit hosts via `--allow-host <host>` (repeatable) to extend
   * or replace the default. Pass `--no-network` to disable HTTP egress
   * entirely. Ignored when `sandbox === "none"`.
   */
  allowedHttpHosts?: string[] | null;
  /**
   * Web-search extension toggle. Default: true (auto-enables when a
   * provider API key env var is present). Pass `--no-web-search` to
   * force-disable.
   */
  webSearch: boolean;
  /**
   * Explicit web-search provider. Overrides auto-detection by env var.
   * Set via `--web-search-provider <tavily|brave|exa>`.
   */
  webSearchProvider?: string;
  /**
   * Per-run cap on combined web_search + web_fetch calls. Default: 30.
   * Set via `--web-search-max-calls <n>`.
   */
  webSearchMaxCalls?: number;
}

export function printHelp(): void {
  process.stdout.write(`agentic-pi — Pi-based coding-agent harness

Usage:
  echo "<prompt>" | agentic-pi run --model <provider/id> [flags]

Flags:
  --model <provider/id>      e.g. anthropic/claude-opus-4-5, openai/gpt-4o
  --thinking <level>         off | minimal | low | medium | high | xhigh
  --profile <name>           GitHub tool profile (read|issues-write|review-write|repo-write)
  --cwd <path>               Working directory (default: $PWD)
  --no-session               Do not persist session jsonl
  --session-dir <path>       Where to persist sessions
  --no-builtin-tools         Disable Pi built-in tools (read,write,edit,bash,grep,find,ls)
  --tools <a,b,c>            Explicit tool allowlist
  --sandbox <none|gondolin>  Route Pi's read/write/edit/bash through a sandbox backend.
                              Default: none. 'gondolin' boots a per-run QEMU micro-VM
                              mounting the cwd at /workspace. Requires QEMU on host;
                              native only (Docker-in-Docker not viable; see SPIKE-gondolin.md).
  --sandbox-env KEY=VAL      Inject env var into the sandbox VM. Repeatable.
                              Ignored when --sandbox=none. When --profile is active,
                              GITHUB_TOKEN and GH_TOKEN are auto-injected from a minted
                              installation token (App PEM never enters the VM).
  --allow-host <host>        Add a host to the sandbox HTTP egress allowlist.
                              Repeatable. First explicit use replaces the default
                              GitHub-only allowlist; subsequent uses extend it.
                              Ignored when --sandbox=none.
  --no-network               Disable HTTP egress from the sandbox entirely.
                              Ignored when --sandbox=none.
  --web-search-provider <p>  Force a web-search provider: tavily | brave | exa.
                              Default: auto-detect from env (Tavily > Exa > Brave).
                              Provider's API key env var must be set:
                              TAVILY_API_KEY, EXA_API_KEY, or BRAVE_SEARCH_API_KEY.
  --no-web-search            Disable the web-search extension entirely
                              (web_search / web_fetch tools not registered).
  --web-search-max-calls <n> Cap combined web_search + web_fetch calls per run.
                              Default: 30. When exceeded, further calls return a
                              structured error result.
  --sandbox-image <name>     Image to boot when --sandbox=gondolin. Values:
                              'default' (recommended) — bundled agentic-pi-dev image
                                with git/gh/node/python/rust baked in (auto-downloaded).
                              'gondolin-builtin' — stock alpine-base:latest, no extras.
                              <absolute path> — directory produced by 'gondolin build'.
                              Default: 'default'.
  --dangerously-skip-permissions   Accepted for compat; Pi has no permission prompts anyway

Reads the prompt from stdin. Emits Pi-native JSONL events on stdout, terminating
with an "agent_end" event that includes synthesized usage/cost data.
`);
}

export function parseArgs(argv: string[]): RunConfig {
  const config: RunConfig = {
    model: "",
    cwd: process.cwd(),
    noSession: false,
    noBuiltinTools: false,
    dangerouslySkipPermissions: false,
    sandbox: "none",
    webSearch: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--model":
      case "-m":
        config.model = next();
        break;
      case "--thinking":
      case "--variant": {
        const v = next();
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(v)) {
          throw new Error(`invalid --thinking level: ${v}`);
        }
        config.thinking = v as RunConfig["thinking"];
        break;
      }
      case "--profile":
        config.profile = next();
        break;
      case "--cwd":
        config.cwd = next();
        break;
      case "--no-session":
        config.noSession = true;
        break;
      case "--session-dir":
        config.sessionDir = next();
        break;
      case "--no-builtin-tools":
        config.noBuiltinTools = true;
        break;
      case "--tools":
        config.tools = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--dangerously-skip-permissions":
        config.dangerouslySkipPermissions = true;
        break;
      case "--sandbox": {
        const v = next();
        if (v !== "none" && v !== "gondolin") {
          throw new Error(`invalid --sandbox '${v}'. Expected: none | gondolin`);
        }
        config.sandbox = v;
        break;
      }
      case "--sandbox-image": {
        const v = next();
        if (v.length === 0) {
          throw new Error(`--sandbox-image requires a non-empty value`);
        }
        config.sandboxImage = v;
        break;
      }
      case "--sandbox-env": {
        const v = next();
        const eq = v.indexOf("=");
        if (eq < 1) {
          throw new Error(`--sandbox-env must be KEY=VAL (got '${v}')`);
        }
        const key = v.slice(0, eq);
        const val = v.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`--sandbox-env KEY must match POSIX identifier rules (got '${key}')`);
        }
        config.sandboxEnv = { ...(config.sandboxEnv ?? {}), [key]: val };
        break;
      }
      case "--allow-host": {
        const v = next().trim();
        if (!v) throw new Error("--allow-host requires a non-empty host");
        if (!/^[A-Za-z0-9.\-*]+$/.test(v)) {
          throw new Error(`--allow-host must be a host pattern (got '${v}')`);
        }
        // First explicit --allow-host replaces the default GitHub list;
        // subsequent ones extend. Pass --no-network first to start from
        // an empty allowlist with HTTP enabled? No — --no-network sets
        // null (HTTP disabled). To start from empty allow-list, pass an
        // explicit `--allow-host` for whatever you want and nothing else.
        const cur = Array.isArray(config.allowedHttpHosts) ? config.allowedHttpHosts : [];
        config.allowedHttpHosts = [...cur, v];
        break;
      }
      case "--no-network":
        config.allowedHttpHosts = null;
        break;
      case "--no-web-search":
        config.webSearch = false;
        break;
      case "--web-search-provider": {
        const v = next().trim();
        if (!v) throw new Error("--web-search-provider requires a value");
        config.webSearchProvider = v;
        break;
      }
      case "--web-search-max-calls": {
        const v = next();
        const n = Number(v);
        if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) {
          throw new Error(`--web-search-max-calls must be a positive integer (got '${v}')`);
        }
        config.webSearchMaxCalls = n;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (!config.model) {
    throw new Error("--model is required (e.g. anthropic/claude-haiku-4-5)");
  }
  if (!config.model.includes("/")) {
    throw new Error(`--model must be 'provider/id', got '${config.model}'`);
  }

  return config;
}
