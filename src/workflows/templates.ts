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

  // 1. Conditional blocks: {{#if varName}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName, body) => {
      const val = ctx[varName];
      // Truthy: non-empty string, non-zero number, non-empty array, true boolean
      const truthy =
        val !== undefined &&
        val !== null &&
        val !== "" &&
        val !== false &&
        val !== 0 &&
        !(Array.isArray(val) && val.length === 0);
      return truthy ? body : "";
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
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key) => {
    const parts = key.split(".");
    if (parts.length === 1) {
      const val = ctx[key];
      if (val === undefined || val === null) return "";
      return String(val);
    }
    // Two-level access: e.g. models.architect
    const [parent, child] = parts;
    const parentVal = ctx[parent];
    if (parentVal === null || typeof parentVal !== "object") return "";
    const nested = (parentVal as Record<string, unknown>)[child];
    if (nested === undefined || nested === null) return "";
    return String(nested);
  });

  return result;
}
