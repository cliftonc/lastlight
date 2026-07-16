import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { composeArgv, composeFileArgs, serverDir } from "../src/cli-server.js";

/**
 * F5 regression fence (monorepo Phase 2, docs/plans/monorepo-migration/02-core-move.md).
 *
 * After the core move, `home` (the git root, where `instance/` and the
 * override symlink live) and the compose root (`<home>/apps/server`, where
 * docker-compose.yml lives) are different directories. Every `docker compose`
 * invocation must therefore pass:
 *   - `-f <home>/apps/server/docker-compose.yml` (the moved compose file),
 *   - a second `-f <home>/docker-compose.override.yml` when the overlay's
 *     override is present — explicit `-f` disables compose's auto-override
 *     loading, so it must be spliced in by hand,
 *   - `--project-directory <home>` so the compose file's `./`-relative paths
 *     (`build.context: .`, `./instance`, `./apps/server/Caddyfile`) keep
 *     resolving against the repo root.
 */
describe("composeArgv (F5 home/serverDir split)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ll-compose-argv-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("points -f at apps/server/docker-compose.yml and --project-directory at home", () => {
    expect(composeArgv(home, ["up", "-d"])).toEqual([
      "compose",
      "-f",
      path.join(home, "apps", "server", "docker-compose.yml"),
      "--project-directory",
      home,
      "up",
      "-d",
    ]);
  });

  it("splices the override as a second -f when present (auto-loading is off with explicit -f)", () => {
    writeFileSync(path.join(home, "docker-compose.override.yml"), "services: {}\n");
    expect(composeArgv(home, ["ps"])).toEqual([
      "compose",
      "-f",
      path.join(home, "apps", "server", "docker-compose.yml"),
      "-f",
      path.join(home, "docker-compose.override.yml"),
      "--project-directory",
      home,
      "ps",
    ]);
  });

  it("keeps docker-compose v1 (no pre args) working", () => {
    expect(composeArgv(home, ["ps"], [])).toEqual([
      "-f",
      path.join(home, "apps", "server", "docker-compose.yml"),
      "--project-directory",
      home,
      "ps",
    ]);
  });

  it("serverDir/composeFileArgs agree on the compose root", () => {
    expect(serverDir(home)).toBe(path.join(home, "apps", "server"));
    expect(composeFileArgs(home)[1]).toBe(path.join(serverDir(home), "docker-compose.yml"));
  });
});
