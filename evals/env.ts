/**
 * Minimal `.env` loader for the eval harness (no dotenv dependency).
 *
 * Reads the repo-root `.env` (KEY=VALUE lines) and sets any keys not already
 * present in `process.env`. The provider key (OPENAI_API_KEY / ANTHROPIC_…)
 * lives there for local dev; the eval needs it to make real model calls.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;
const HERE = dirname(fileURLToPath(import.meta.url));

export function loadDotEnv(root = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** True if at least one provider key the eval can use is set. */
export function hasProviderKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.FIREWORKS_API_KEY ||
      process.env.DEEPSEEK_API_KEY,
  );
}

export interface ModelEntry {
  id: string;
  label?: string;
  provider?: string;
  envKey?: string;
}
interface ModelsConfig {
  default: string;
  compare: ModelEntry[];
}

function modelsConfig(): ModelsConfig {
  return JSON.parse(readFileSync(join(HERE, "models.json"), "utf8")) as ModelsConfig;
}

/** Single-model run: EVAL_MODELS override, else the `default` from models.json. */
export function evalModels(): string[] {
  const raw = process.env.EVAL_MODELS?.trim();
  if (raw) return raw.split(",").map((m) => m.trim()).filter(Boolean);
  return [modelsConfig().default];
}

/**
 * Cross-vendor comparison set from `models.json`, filtered to the models whose
 * provider key is actually present — so `npm run eval:compare` runs whatever
 * you have keys for and silently skips the rest.
 */
export function compareModels(): ModelEntry[] {
  return modelsConfig().compare.filter((m) => !m.envKey || Boolean(process.env[m.envKey]));
}

/** id → display label, from models.json (for the scorecard). */
export function modelLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of modelsConfig().compare) if (m.label) out[m.id] = m.label;
  return out;
}

/** Provider family (env-key) inferred from a `provider/model` id prefix. */
export function familyForId(id: string): string {
  const provider = id.split("/")[0]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  return map[provider] ?? "default";
}

/**
 * Resolve a user-supplied model token (from `--model`) to a concrete entry.
 * Matches a models.json `compare` id exactly, else a case-insensitive substring
 * of its id or label (so `--model haiku` works); failing that, treats the token
 * as a raw `provider/model` id and infers the family from its prefix. Not
 * key-gated — `--model` is an explicit request, so we run it even if the key
 * check would otherwise skip it (the provider call surfaces a missing key).
 */
export function resolveModel(token: string): ModelEntry & { family: string } {
  const all = modelsConfig().compare;
  const v = token.toLowerCase();
  const hit =
    all.find((m) => m.id === token) ??
    all.find((m) => m.id.toLowerCase().includes(v) || m.label?.toLowerCase().includes(v));
  if (hit) return { ...hit, family: hit.envKey ?? familyForId(hit.id) };
  return { id: token, family: familyForId(token) };
}
