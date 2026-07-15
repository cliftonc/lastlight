import { describe, it, expect } from "vitest";
import { resolveConfigLayers } from "#src/config/config-resolve.js";

describe("resolveConfigLayers — scalar precedence", () => {
  it("env wins over overlay and default, and records the source as env", () => {
    const resolved = resolveConfigLayers({
      default: { model: "from-default" },
      overlay: { model: "from-overlay" },
      env: { model: "from-env" },
    });
    expect(resolved.value.model).toBe("from-env");
    expect(resolved.sources.model).toBe("env");
  });

  it("overlay wins over default when env does not supply the key", () => {
    const resolved = resolveConfigLayers({
      default: { model: "from-default" },
      overlay: { model: "from-overlay" },
      env: {},
    });
    expect(resolved.value.model).toBe("from-overlay");
    expect(resolved.sources.model).toBe("overlay");
  });

  it("falls back to default when neither overlay nor env supplies the key", () => {
    const resolved = resolveConfigLayers({
      default: { model: "from-default" },
      overlay: null,
      env: {},
    });
    expect(resolved.value.model).toBe("from-default");
    expect(resolved.sources.model).toBe("default");
  });
});

describe("resolveConfigLayers — map (models) precedence", () => {
  it("merges maps key-by-key, attributing each leaf to its winning layer", () => {
    const resolved = resolveConfigLayers({
      default: { models: { default: "default-model" } },
      overlay: { models: { architect: "overlay-architect" } },
      env: { models: { default: "env-default" } },
    });
    expect(resolved.value.models).toEqual({
      default: "env-default",
      architect: "overlay-architect",
    });
    const sources = resolved.sources.models as Record<string, unknown>;
    expect(sources.default).toBe("env");
    expect(sources.architect).toBe("overlay");
  });
});

describe("resolveConfigLayers — nested objects and arrays", () => {
  it("merges nested object leaves independently with a mirrored sources tree", () => {
    const resolved = resolveConfigLayers({
      default: { otel: { enabled: false, serviceName: "lastlight" } },
      overlay: { otel: { serviceName: "overlay-svc" } },
      env: { otel: { enabled: true } },
    });
    expect(resolved.value.otel).toEqual({ enabled: true, serviceName: "overlay-svc" });
    expect(resolved.sources.otel).toEqual({ enabled: "env", serviceName: "overlay" });
  });

  it("replaces arrays wholesale and attributes the whole array to one source", () => {
    const resolved = resolveConfigLayers({
      default: { managedRepos: ["default/repo"] },
      overlay: { managedRepos: ["overlay/a", "overlay/b"] },
      env: {},
    });
    expect(resolved.value.managedRepos).toEqual(["overlay/a", "overlay/b"]);
    expect(resolved.sources.managedRepos).toBe("overlay");
  });
});
