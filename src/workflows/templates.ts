/**
 * Minimal template engine for workflow prompt files.
 *
 * Supports:
 *   {{varName}}            — simple variable substitution
 *   {{slugify varName}}    — slugify helper applied to a variable
 *   {{branchUrl file}}     — generate a GitHub branch URL for a file in issueDir
 *   {{#if varName}}...{{/if}} — conditional blocks (no nesting, truthy check)
 */

export interface TemplateContext {
  // Core build request
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  commentBody: string;
  sender: string;

  // Computed from build request
  branch: string;
  taskId: string;
  issueDir: string;
  bootstrapLabel: string;

  // Optional: available during PR phase
  approved?: boolean;
  fixCycles?: number;
  reviewerNote?: string;
  docLinks?: string;

  // Optional: available during fix/re-review phases
  fixCycle?: number;

  // Optional: PR fix request context
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  failedChecks?: string;
  ciSection?: string;

  // Optional: context snapshot (for architect prompt)
  contextSnapshot?: string;

  // Optional: available during generic loop iterations
  iteration?: number;
  maxIterations?: number;
  previousOutput?: string;

  // Optional: phase outputs from DAG workflow (${phaseName.output} substitution).
  // Values may be strings or structured data (e.g. { approved: true, cycles: 1 })
  // when a phase emits an object via output_var — templates can read
  // {{phaseName.field}} for nested access and ${phaseName.output} for strings.
  phaseOutputs?: Record<string, unknown>;

  // Arbitrary extra context
  [key: string]: unknown;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Render a template string with the given context.
 * Processes: {{#if}}, {{slugify}}, {{branchUrl}}, {{varName}}.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  let result = template;

  // 0. Phase output substitution: ${phaseName.output} → phaseOutputs[phaseName]
  if (ctx.phaseOutputs) {
    const phaseOutputs = ctx.phaseOutputs;
    result = result.replace(/\$\{(\w+)\.output\}/g, (_match, phaseName: string) => {
      const val = phaseOutputs[phaseName];
      if (val === undefined || val === null) return "";
      return typeof val === "string" ? val : String((val as { output?: unknown })?.output ?? JSON.stringify(val));
    });
  }

  // 1. Conditional blocks: {{#if varName}}...{{/if}} (supports dot notation for
  //    two-level lookups into ctx or ctx.phaseOutputs).
  result = result.replace(
    /\{\{#if\s+(!?)(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, negate, varName, body) => {
      const parts = varName.split(".");
      let val: unknown;
      if (parts.length === 1) {
        val = ctx[varName];
      } else {
        const [parent, child] = parts;
        let parentVal: unknown = ctx[parent];
        if (parentVal === undefined || parentVal === null) {
          parentVal = ctx.phaseOutputs?.[parent];
        }
        val = parentVal && typeof parentVal === "object"
          ? (parentVal as Record<string, unknown>)[child]
          : undefined;
      }
      // Truthy: non-empty string, non-zero number, non-empty array, true boolean
      const truthy =
        val !== undefined &&
        val !== null &&
        val !== "" &&
        val !== false &&
        val !== 0 &&
        !(Array.isArray(val) && val.length === 0);
      return (negate ? !truthy : truthy) ? body : "";
    }
  );

  // 2. Slugify helper: {{slugify varName}}
  result = result.replace(/\{\{slugify\s+(\w+)\}\}/g, (_match, varName) => {
    const val = ctx[varName];
    if (val === undefined || val === null) return "";
    return slugify(String(val));
  });

  // 3. Branch URL helper: {{branchUrl filename}}
  // Generates: https://github.com/{owner}/{repo}/blob/{branch}/.lastlight/issue-{N}/{file}
  result = result.replace(/\{\{branchUrl\s+(\S+)\}\}/g, (_match, file) => {
    const encoded = encodeURIComponent(ctx.branch);
    return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${encoded}/${ctx.issueDir}/${file}`;
  });

  // 4. Simple variable substitution: {{varName}} and {{nested.key}} (single level)
  //    Two-level access (`{{parent.child}}`) first checks top-level ctx, then
  //    falls back to ctx.phaseOutputs[parent] so YAML phases can emit structured
  //    output via `output_var` and downstream prompts can read it directly.
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key) => {
    const parts = key.split(".");
    if (parts.length === 1) {
      const val = ctx[key];
      if (val === undefined || val === null) return "";
      return typeof val === "object" ? JSON.stringify(val) : String(val);
    }
    const [parent, child] = parts;
    let parentVal: unknown = ctx[parent];
    if (parentVal === undefined || parentVal === null) {
      parentVal = ctx.phaseOutputs?.[parent];
    }
    if (parentVal === null || typeof parentVal !== "object") return "";
    const nested = (parentVal as Record<string, unknown>)[child];
    if (nested === undefined || nested === null) return "";
    return typeof nested === "object" ? JSON.stringify(nested) : String(nested);
  });

  return result;
}
