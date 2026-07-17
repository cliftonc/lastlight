import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveTelemetryConfig } from "../../src/telemetry/config.js";

describe("resolveTelemetryConfig — enablement precedence", () => {
  test("--no-otel wins over env AGENTIC_PI_OTEL_ENABLED", () => {
    const c = resolveTelemetryConfig({ otel: false }, { AGENTIC_PI_OTEL_ENABLED: "1" });
    assert.equal(c.enabled, false);
    assert.equal(c.reason, "disabled-by-flag");
  });

  test("--otel enables", () => {
    const c = resolveTelemetryConfig({ otel: true }, {});
    assert.equal(c.enabled, true);
    assert.equal(c.reason, undefined);
  });

  test("env AGENTIC_PI_OTEL_ENABLED enables when flag unset", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      const c = resolveTelemetryConfig({}, { AGENTIC_PI_OTEL_ENABLED: v });
      assert.equal(c.enabled, true, `expected ${v} to enable`);
    }
  });

  test("falsey env values do not enable", () => {
    for (const v of ["0", "false", "no", "", "off"]) {
      const c = resolveTelemetryConfig({}, { AGENTIC_PI_OTEL_ENABLED: v });
      assert.equal(c.enabled, false, `expected ${v} to stay disabled`);
      assert.equal(c.reason, "not-enabled");
    }
  });

  test("bare OTEL_EXPORTER_OTLP_ENDPOINT does NOT enable", () => {
    const c = resolveTelemetryConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    assert.equal(c.enabled, false);
    assert.equal(c.reason, "not-enabled");
  });

  test("unset everything → disabled, not-enabled", () => {
    const c = resolveTelemetryConfig({}, {});
    assert.equal(c.enabled, false);
    assert.equal(c.reason, "not-enabled");
  });
});

describe("resolveTelemetryConfig — content + service name", () => {
  test("content off by default", () => {
    assert.equal(resolveTelemetryConfig({ otel: true }, {}).includeContent, false);
  });

  test("--otel-include-content enables content", () => {
    const c = resolveTelemetryConfig({ otel: true, otelIncludeContent: true }, {});
    assert.equal(c.includeContent, true);
  });

  test("env AGENTIC_PI_OTEL_INCLUDE_CONTENT enables content", () => {
    const c = resolveTelemetryConfig({ otel: true }, { AGENTIC_PI_OTEL_INCLUDE_CONTENT: "1" });
    assert.equal(c.includeContent, true);
  });

  test("flag service name wins over OTEL_SERVICE_NAME", () => {
    const c = resolveTelemetryConfig(
      { otel: true, otelServiceName: "flagged" },
      { OTEL_SERVICE_NAME: "from-env" },
    );
    assert.equal(c.serviceName, "flagged");
  });

  test("OTEL_SERVICE_NAME used when flag absent", () => {
    const c = resolveTelemetryConfig({ otel: true }, { OTEL_SERVICE_NAME: "from-env" });
    assert.equal(c.serviceName, "from-env");
  });

  test("endpoint override passed through", () => {
    const c = resolveTelemetryConfig({ otel: true, otelEndpoint: "http://collector:4318" }, {});
    assert.equal(c.endpoint, "http://collector:4318");
  });
});
