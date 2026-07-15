/**
 * Server-side store for build handoff docs ("server mode").
 *
 * In the default "repo" mode the per-phase docs (architect-plan.md, status.md,
 * executor-summary.md, reviewer-verdict.md, …) are committed into the target
 * repo under `.lastlight/<issueKey>/` and ride the working branch. In "server"
 * mode they live here instead — on the Last Light host, never committed — and
 * are staged into each sandbox phase from outside the repo (the same way skills
 * are) and harvested back after the phase runs.
 *
 * Layout mirrors the rest of `$STATE_DIR` (opencode-home/projects, sandboxes):
 *
 *   <root>/<owner>/<repo>/<issueKey>/<file>.md
 *
 * `root` defaults to `$STATE_DIR/build-assets` (override `BUILD_ASSETS_DIR`).
 * Every path segment is validated to stay inside `root` — the admin API serves
 * these by name, so traversal must be impossible.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve, sep } from "path";

/** Identity of one run's doc set within the store. */
export interface BuildAssetRef {
  owner: string;
  repo: string;
  issueKey: string;
}

/**
 * Derive the stable per-run key used both as the store sub-path and (with a
 * `.lastlight/` prefix) as the in-repo `issueDir`. Issue-scoped runs share a
 * key by issue number; non-issue runs (explore, health, …) get a run-scoped
 * key so concurrent sessions never overlap. Mirrors the derivation that lived
 * inline in `src/workflows/simple.ts`.
 */
export function buildAssetIssueKey(
  workflowName: string,
  issueNumber: number | undefined,
  workflowId: string,
): string {
  return issueNumber !== undefined
    ? `issue-${issueNumber}`
    : `${workflowName}-${workflowId.slice(0, 8)}`;
}

/**
 * A single path segment (owner / repo / issueKey / filename) is safe when it is
 * non-empty, carries no path separators, and is not a `.`/`..` traversal token.
 * GitHub owners/repos and our own issueKeys/filenames all satisfy this; anything
 * else is rejected rather than sanitized so a bad input fails loudly.
 */
function assertSafeSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Unsafe build-asset ${label}: ${JSON.stringify(segment)}`);
  }
}

/** True when `child` resolves to a path inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

export class BuildAssetStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute directory for a run's doc set. Validates every segment. */
  dirFor(ref: BuildAssetRef): string {
    assertSafeSegment(ref.owner, "owner");
    assertSafeSegment(ref.repo, "repo");
    assertSafeSegment(ref.issueKey, "issueKey");
    const dir = join(this.root, ref.owner, ref.repo, ref.issueKey);
    if (!isInside(this.root, dir)) {
      throw new Error(`build-asset dir escapes store root: ${dir}`);
    }
    return dir;
  }

  /** Absolute path for one doc file, with traversal validation on the name. */
  fileFor(ref: BuildAssetRef, file: string): string {
    assertSafeSegment(file, "filename");
    const path = join(this.dirFor(ref), file);
    if (!isInside(this.root, path)) {
      throw new Error(`build-asset file escapes store root: ${path}`);
    }
    return path;
  }

  /** Read one doc, or undefined when it does not exist. */
  read(ref: BuildAssetRef, file: string): string | undefined {
    const path = this.fileFor(ref, file);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  }

  /**
   * Read one doc as raw bytes, or undefined when it does not exist. Same
   * traversal validation as {@link read}, but no text decoding — the admin
   * API uses this to serve binary artifacts (e.g. PNG screenshot evidence)
   * intact, since `read()`'s utf-8 decode corrupts binary content.
   */
  readBuffer(ref: BuildAssetRef, file: string): Buffer | undefined {
    const path = this.fileFor(ref, file);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  /** Write (create or overwrite) one doc, creating the run dir as needed. */
  write(ref: BuildAssetRef, file: string, content: string): void {
    const path = this.fileFor(ref, file);
    mkdirSync(this.dirFor(ref), { recursive: true });
    writeFileSync(path, content);
  }

  /** List the `<owner>/<repo>` run keys present in the store (issueKeys). */
  listKeys(owner: string, repo: string): string[] {
    assertSafeSegment(owner, "owner");
    assertSafeSegment(repo, "repo");
    const dir = join(this.root, owner, repo);
    if (!isInside(this.root, dir) || !existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /** List the doc filenames stored for one run. */
  listFiles(ref: BuildAssetRef): string[] {
    const dir = this.dirFor(ref);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }

  /**
   * Stage the run's stored docs into `localDir` (created fresh) so a sandbox
   * phase reads prior-phase context. A no-op-with-empty-dir when nothing is
   * stored yet — the first phase starts from a clean slate, identical to repo
   * mode's empty `.lastlight/<issueKey>/`.
   */
  stageInto(ref: BuildAssetRef, localDir: string): void {
    mkdirSync(localDir, { recursive: true });
    const src = this.dirFor(ref);
    if (!existsSync(src)) return;
    cpSync(src, localDir, { recursive: true });
  }

  /**
   * Harvest docs written by a phase back into the store, replacing the stored
   * set with whatever the phase left in `localDir`. Last-harvest-wins; the
   * runner is sequential per workspace so there is no concurrent writer.
   */
  harvestFrom(ref: BuildAssetRef, localDir: string): void {
    if (!existsSync(localDir) || !statSync(localDir).isDirectory()) return;
    const dest = this.dirFor(ref);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(localDir, dest, { recursive: true });
  }
}
