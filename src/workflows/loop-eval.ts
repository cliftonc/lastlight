/**
 * Minimal expression evaluator for generic loop `until` conditions.
 *
 * Supported forms:
 *   output.contains('text')   — true if the output string contains 'text'
 *   variable == 'value'       — equality check against the context map
 *   variable != 'value'       — inequality check against the context map
 *
 * Deliberately limited to avoid eval() and expression-injection risk.
 * Complex conditions should use until_bash instead.
 */

export interface LoopEvalContext {
  output: string;
  [key: string]: string;
}

/**
 * Evaluate a single until expression against the given context.
 * Returns false (safe default) for any unrecognised expression.
 */
export function evalUntilExpression(expr: string, ctx: LoopEvalContext): boolean {
  const trimmed = expr.trim();

  // output.contains('text') or output.contains("text")
  const containsMatch = trimmed.match(/^output\.contains\(['"](.+)['"]\)$/);
  if (containsMatch) {
    return ctx.output.includes(containsMatch[1]);
  }

  // variable == 'value' or variable == "value"
  const eqMatch = trimmed.match(/^(\w+)\s*==\s*['"](.+)['"]$/);
  if (eqMatch) {
    const [, key, value] = eqMatch;
    return ctx[key] === value;
  }

  // variable != 'value' or variable != "value"
  const neqMatch = trimmed.match(/^(\w+)\s*!=\s*['"](.+)['"]$/);
  if (neqMatch) {
    const [, key, value] = neqMatch;
    if (!(key in ctx)) return false; // absent variable — safe default
    return ctx[key] !== value;
  }

  // Unrecognised — safe default
  return false;
}
