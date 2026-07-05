/**
 * Behavioural test for the pr-review `post-review` phase's diff parser.
 *
 * The parser lives as inline JS inside `workflows/pr-review.yaml` (a `type:
 * script` phase runs it in the sandbox, so it can't import a shared helper).
 * To avoid drift, this test extracts the ACTUAL `parseDiff` function from the
 * shipped YAML and exercises it — no second copy to keep in sync.
 *
 * `parseDiff` maps a unified diff to `path -> Set<"SIDE:line">`: added/context
 * lines are `RIGHT:<newLine>`, removed/context lines are `LEFT:<oldLine>`. The
 * phase anchors a finding inline only when its `side:line` is in that set
 * (GitHub 422s on comments off the diff); everything else is demoted to the
 * review body.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Slice a top-level `function <name>(...) { ... }` out of a source string by
 *  brace-matching (the parser body contains no braces inside strings/regex). */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in script`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      i++;
      break;
    }
  }
  return src.slice(start, i);
}

const yamlPath = join(__dirname, "../../workflows/pr-review.yaml");
const wf = parseYaml(readFileSync(yamlPath, "utf8")) as { phases: { name: string; script?: string }[] };
const postReview = wf.phases.find((p) => p.name === "post-review");
const script = postReview?.script ?? "";
// eslint-disable-next-line no-eval
const parseDiff = eval(`(${extractFn(script, "parseDiff")})`) as (diff: string) => Map<string, Set<string>>;

describe("pr-review post-review parseDiff (extracted from workflows/pr-review.yaml)", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -10,3 +10,4 @@ function x() {",
    " context1",
    "-removed",
    "+added1",
    "+added2",
    " context2",
  ].join("\n");

  it("maps added lines to RIGHT and removed lines to LEFT with correct numbering", () => {
    const map = parseDiff(diff);
    const set = map.get("src/foo.ts")!;
    expect(set).toBeDefined();
    // context1 @ new 10 / old 10; removed @ old 11; added1 @ new 11; added2 @ new 12;
    // context2 @ new 13 / old 12.
    expect(set.has("RIGHT:10")).toBe(true); // context1
    expect(set.has("LEFT:11")).toBe(true); // removed
    expect(set.has("RIGHT:11")).toBe(true); // added1
    expect(set.has("RIGHT:12")).toBe(true); // added2
    expect(set.has("RIGHT:13")).toBe(true); // context2
    expect(set.has("LEFT:12")).toBe(true); // context2 on the old side
  });

  it("does not mark off-diff or wrong-side lines as commentable", () => {
    const map = parseDiff(diff);
    const set = map.get("src/foo.ts")!;
    expect(set.has("RIGHT:99")).toBe(false); // beyond the hunk
    expect(set.has("LEFT:11") && set.has("RIGHT:11")).toBe(true);
    expect(set.has("RIGHT:100")).toBe(false);
  });

  it("handles a pure-addition file (new file, /dev/null base)", () => {
    const added = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n");
    const map = parseDiff(added);
    const set = map.get("new.ts")!;
    expect(set.has("RIGHT:1")).toBe(true);
    expect(set.has("RIGHT:2")).toBe(true);
    expect(set.has("LEFT:1")).toBe(false);
  });
});
