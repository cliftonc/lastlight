import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { bundleRoot } from "../src/skills-install.js";
import { resolveForkTarget } from "../src/fork-cli.js";

/**
 * Locked decision 12 regression pin. In `packages/cli` the compiled bin is
 * `dist/cli.js` (one level below the package root), and `bundleRoot()` /
 * `bundledAssetRoot` / `cliVersion()` resolve the package root via `..` from
 * the compiled file's dir. This test pins that resolution + the removal of
 * `fork-cli`'s bundled-asset fallback (the CLI no longer ships
 * workflows/skills/agent-context).
 */
describe("CLI package-root resolution (decision 12)", () => {
  it("bundleRoot() resolves the `lastlight` package root with plugins/lastlight/", () => {
    const root = bundleRoot();
    const pkgPath = join(root, "package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    expect(pkg.name).toBe("lastlight");
    expect(existsSync(join(root, "plugins", "lastlight"))).toBe(true);
    expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  it("fork-cli's no-candidate path throws a --home pointer instead of falling back", () => {
    // An overlay-only dir (no workflows/ + skills/) and no colocated checkout:
    // the removed bundled fallback means this now errors, pointing at --home.
    const overlayOnly = mkdtempSync(join(tmpdir(), "cli-pkgroot-"));
    mkdirSync(join(overlayOnly, "secrets"), { recursive: true });
    expect(() => resolveForkTarget({ home: overlayOnly })).toThrow(/--home/);
  });
});
