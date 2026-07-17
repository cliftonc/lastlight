import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Drift guard for the committed sandbox agentic-pi pin.
 *
 * The sandbox images install the PUBLISHED agentic-pi from npm (the Dockerfiles
 * curl `agentic-pi-<version>.tgz` and verify its sha512 against this pin's
 * integrity line) rather than the in-repo build. agentic-pi now lives in this
 * monorepo as a `workspace:*` package, so the pnpm-lock.yaml no longer carries a
 * registry `resolution.integrity` for it — the pin is derived from the package's
 * own version (packages/agentic-pi/package.json) + the integrity npm reports for
 * that published version (scripts/agentic-pi-pin.sh).
 *
 * This guard is deliberately OFFLINE: it asserts the pin's version line matches
 * packages/agentic-pi/package.json (so a forgotten `scripts/agentic-pi-pin.sh`
 * regeneration after a version bump fails CI) and that the integrity line is a
 * well-formed sha512 SRI string. It does NOT re-fetch from npm — verifying the
 * integrity actually matches the published tarball is the Dockerfile's job at
 * build time.
 */
/** Walk upward from `start` to the monorepo root (the dir holding pnpm-lock.yaml). */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "pnpm-lock.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-lock.yaml not found above ${start}`);
    dir = parent;
  }
  return dir;
}

describe("sandbox/agentic-pi.pin", () => {
  it("pins the agentic-pi workspace package's version + a valid sha512 integrity", () => {
    const workspaceRoot = findWorkspaceRoot(resolve("."));
    const pkg = JSON.parse(
      readFileSync(join(workspaceRoot, "packages/agentic-pi/package.json"), "utf-8"),
    );

    const pin = readFileSync(resolve("sandbox/agentic-pi.pin"), "utf-8");
    const [version, integrity] = pin.split("\n");

    expect(
      version,
      "sandbox/agentic-pi.pin version is out of date — run scripts/agentic-pi-pin.sh",
    ).toBe(pkg.version);

    // sha512-<base64> — the Subresource-Integrity form npm and the Dockerfile use.
    expect(
      integrity,
      "sandbox/agentic-pi.pin integrity line is not a sha512 SRI string",
    ).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });
});
