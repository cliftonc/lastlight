import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ['src/**/*.test.ts'],
    // Force LASTLIGHT_LOCAL_DEV=1 so any test that touches configureGitAuth
    // (or imports a code path that does) skips the `git config --global`
    // writes that would otherwise overwrite the contributor's real git
    // identity with `last-light[bot]`. Existing tests that explicitly
    // exercise the global-write path can still `delete process.env.LASTLIGHT_LOCAL_DEV`
    // in beforeEach (see src/engine/git-auth.test.ts).
    env: {
      LASTLIGHT_LOCAL_DEV: "1",
    },
  },
});
