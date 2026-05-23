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
