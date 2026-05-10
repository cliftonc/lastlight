import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  AgentWorkflowSchema,
  CronWorkflowSchema,
  type AgentWorkflowDefinition,
  type CronWorkflowDefinition,
} from "./schema.js";

// Default workflow directory (relative to cwd at startup)
const DEFAULT_WORKFLOW_DIR = resolve("workflows");

let workflowDir = DEFAULT_WORKFLOW_DIR;

/** Override the workflow directory (used in tests and from config). */
export function setWorkflowDir(dir: string): void {
  workflowDir = resolve(dir);
}

/** Cache: name → definition */
const agentCache = new Map<string, AgentWorkflowDefinition>();
const cronCache = new Map<string, CronWorkflowDefinition>();
let cachePopulated = false;

/** Clear the in-memory cache (used in tests). */
export function clearWorkflowCache(): void {
  agentCache.clear();
  cronCache.clear();
  cachePopulated = false;
}

/**
 * Load and validate a single YAML file.
 * Throws with a descriptive message if the file is missing or invalid.
 */
function loadYamlFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    return parseYaml(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML in ${filePath}: ${msg}`);
  }
}

/**
 * Populate the cache by scanning the workflow directory.
 * Called lazily on first access.
 *
 * Distinguishes cron schedules (kind: cron) from runnable agent workflows
 * (everything else, including agent / build / triage / review / etc.).
 */
function populateCache(): void {
  if (cachePopulated) return;
  cachePopulated = true;

  if (!existsSync(workflowDir)) {
    console.warn(`[loader] Workflow directory not found: ${workflowDir} — no workflows loaded`);
    return;
  }

  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  for (const file of files) {
    const filePath = join(workflowDir, file);
    let raw: unknown;
    try {
      raw = loadYamlFile(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[loader] Error loading ${filePath}: ${msg}`);
      continue;
    }

    // Cron schedules carry kind: cron and reference an AgentWorkflow by name.
    // Everything else is parsed as a runnable agent workflow.
    const kind = (raw as Record<string, unknown>)?.kind;

    if (kind === "cron") {
      const result = CronWorkflowSchema.safeParse(raw);
      if (!result.success) {
        console.error(`[loader] Invalid cron workflow in ${file}:`, result.error.format());
        continue;
      }
      cronCache.set(result.data.name, result.data);
    } else {
      const result = AgentWorkflowSchema.safeParse(raw);
      if (!result.success) {
        console.error(`[loader] Invalid agent workflow in ${file}:`, result.error.format());
        continue;
      }
      agentCache.set(result.data.name, result.data);
    }
  }
}

/**
 * Load and validate a named agent workflow YAML.
 * Throws if the workflow doesn't exist or fails validation.
 */
export function getWorkflow(name: string): AgentWorkflowDefinition {
  populateCache();
  const cached = agentCache.get(name);
  if (cached) return cached;

  // Try loading directly from a file named {name}.yaml
  const candidates = [
    join(workflowDir, `${name}.yaml`),
    join(workflowDir, `${name}.yml`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      const raw = loadYamlFile(filePath);
      const result = AgentWorkflowSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `Invalid workflow "${name}" in ${filePath}: ${JSON.stringify(result.error.format())}`
        );
      }
      agentCache.set(name, result.data);
      return result.data;
    }
  }

  throw new Error(`Workflow not found: "${name}" (looked in ${workflowDir})`);
}

/**
 * Return all cron workflow definitions (from cron-*.yaml files).
 */
export function getCronWorkflows(): CronWorkflowDefinition[] {
  populateCache();
  return Array.from(cronCache.values());
}

/**
 * Return every agent (non-cron) workflow definition currently on disk.
 * Used by the admin dashboard to list all browseable workflows.
 */
export function listAgentWorkflows(): AgentWorkflowDefinition[] {
  populateCache();
  return Array.from(agentCache.values());
}

/**
 * Return the raw YAML file contents for a named agent workflow. Preserves
 * comments and original formatting — used by the dashboard's YAML viewer.
 */
export function loadWorkflowYamlRaw(name: string): string {
  for (const ext of ["yaml", "yml"]) {
    const filePath = join(workflowDir, `${name}.${ext}`);
    if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
  }
  throw new Error(`Workflow file not found: ${name}.{yaml,yml} in ${workflowDir}`);
}

/**
 * Read a prompt template file from the workflow directory.
 * Throws if the file doesn't exist or if the path escapes `workflowDir`.
 */
export function loadPromptTemplate(relativePath: string): string {
  const filePath = resolvePromptPath(relativePath);
  return readFileSync(filePath, "utf-8");
}

/**
 * Validate and resolve a prompt path against the workflow directory. Rejects
 * absolute paths and any traversal that escapes `workflowDir`. Exported so
 * admin routes can reuse the same guard.
 */
export function resolvePromptPath(relativePath: string): string {
  if (!relativePath || relativePath.length === 0) {
    throw new Error(`Prompt path is empty`);
  }
  const filePath = resolve(workflowDir, relativePath);
  if (!filePath.startsWith(workflowDir + "/") && filePath !== workflowDir) {
    throw new Error(`Prompt path escapes workflow directory: ${relativePath}`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`Prompt template not found: ${filePath}`);
  }
  return filePath;
}

// ── Skills ────────────────────────────────────────────────────────────

const SKILL_BASES = [resolve("skills"), resolve(".claude/skills")];

/**
 * Return the raw SKILL.md content for a named skill. Tries `skills/<name>/`
 * first, falling back to `.claude/skills/<name>/` (matches the legacy
 * executeSkill lookup order).
 */
export function loadSkillRaw(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  for (const base of SKILL_BASES) {
    const filePath = join(base, name, "SKILL.md");
    if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
  }
  throw new Error(`Skill not found: skills/${name}/SKILL.md`);
}

/**
 * Wrap a skill's SKILL.md content in the canonical executor preamble used by
 * skill-style phases. Kept here (instead of in runner.ts) so the admin layer
 * can call `loadSkillRaw` without importing the runner.
 */
export function loadSkillInstructions(name: string): string {
  return loadSkillRaw(name);
}
