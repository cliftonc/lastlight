import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only our own harness tests (the deterministic, AI-free `mechanism.test.ts`
    // seam guard). `datasets/**` holds code-fix FIXTURE tests — held-out tests
    // run inside a seeded workspace at grade time, never collected here.
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "datasets/**"],
  },
});
