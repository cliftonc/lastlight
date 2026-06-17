import { describe, expect, it, vi, afterEach } from "vitest";
import { getOtelEnvForSandbox, isTelemetryEnabled, safeMetricAttributes, shutdownTelemetry, withSpan } from "./index.js";

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
