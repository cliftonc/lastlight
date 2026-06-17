import { describe, expect, it, vi, afterEach } from "vitest";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, isTelemetryEnabled, safeMetricAttributes, shutdownTelemetry, withSpan } from "./index.js";
import { OTEL_COLLECTOR_SANDBOX_ENDPOINT } from "../sandbox/egress-firewall-config.js";

describe("telemetry helpers", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await shutdownTelemetry();
  });

  it("is no-op safe when disabled", async () => {
    expect(isTelemetryEnabled()).toBe(false);
    await expect(withSpan("test", {}, async (span) => {
      expect(span).toBeUndefined();
      return 42;
    })).resolves.toBe(42);
  });

  it("forwards only allowlisted OTEL env vars", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example.com");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer token");
    vi.stubEnv("OPENAI_API_KEY", "secret");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=test");
    expect(getOtelEnvForSandbox()).toEqual({
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer token",
    });
  });

  it("omits newline-bearing env values", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=bad\nheader");
    expect(getOtelEnvForSandbox()).toEqual({});
  });

  it("omits single-quote-bearing env values (would break docker --sandbox-env shell wrap)", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example.com");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer it's-bad");
    // The safe endpoint is still forwarded; only the unsafe header is dropped,
    // so the agent run proceeds instead of docker.ts throwing on the quote.
    expect(getOtelEnvForSandbox()).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
    });
  });

  it("docker sandbox env points at the in-network collector, never the real backend or headers", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://real-backend.example.com:4318");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer super-secret");
    vi.stubEnv("OTEL_SERVICE_NAME", "lastlight");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=prod");
    const env = getDockerSandboxOtelEnv();
    // Endpoint is the internal collector, NOT the real backend.
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(OTEL_COLLECTOR_SANDBOX_ENDPOINT);
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/protobuf");
    // Safe labels pass through; the secret header does not (and there's no
    // OTEL_EXPORTER_OTLP_HEADERS key at all).
    expect(env.OTEL_SERVICE_NAME).toBe("lastlight");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("deployment.environment=prod");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(Object.values(env).some((v) => v.includes("super-secret"))).toBe(false);
  });

  it("drops high-cardinality metric attributes", () => {
    expect(safeMetricAttributes({
      surface: "phase",
      "workflow.name": "build",
      "trigger.id": "owner/repo#1",
      "session.id": "abc",
      branch: "feature",
      prompt: "secret prompt",
      stack: "trace",
      success: true,
    })).toEqual({
      surface: "phase",
      "workflow.name": "build",
      success: true,
    });
  });
});
