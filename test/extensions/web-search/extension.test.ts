import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  loadWebSearchExtension,
  isMisconfigurationSkip,
  DEFAULT_MAX_CALLS,
} from "../../../src/extensions/web-search/index.js";

describe("loadWebSearchExtension", () => {
  test("no keys present → silent skip, no tools", () => {
    const r = loadWebSearchExtension({ env: {} });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "no-credentials");
    assert.equal(r.customTools.length, 0);
    assert.equal(r.toolNames.length, 0);
    assert.equal(isMisconfigurationSkip(r), false);
  });

  test("--no-web-search → skipped, disabled-by-flag, no tools", () => {
    const r = loadWebSearchExtension({
      webSearch: false,
      env: { TAVILY_API_KEY: "tvly-x" },
    });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "disabled-by-flag");
    assert.equal(r.customTools.length, 0);
  });

  test("Tavily key set → configured, two tools, default max calls", () => {
    const r = loadWebSearchExtension({ env: { TAVILY_API_KEY: "tvly-x" } });
    assert.equal(r.status, "configured");
    assert.equal(r.provider, "tavily");
    assert.deepEqual(r.toolNames.sort(), ["web_fetch", "web_search"]);
    assert.equal(r.maxCalls, DEFAULT_MAX_CALLS);
  });

  test("custom max calls is honored and clamped to >=1", () => {
    const r1 = loadWebSearchExtension({
      env: { TAVILY_API_KEY: "tvly-x" },
      webSearchMaxCalls: 5,
    });
    assert.equal(r1.maxCalls, 5);

    const r2 = loadWebSearchExtension({
      env: { TAVILY_API_KEY: "tvly-x" },
      webSearchMaxCalls: 0,
    });
    assert.equal(r2.maxCalls, 1);
  });

  test("explicit provider with missing key → misconfig skip", () => {
    const r = loadWebSearchExtension({
      webSearchProvider: "brave",
      env: { TAVILY_API_KEY: "tvly-x" },
    });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "no-credentials");
    assert.equal(r.provider, "brave");
    assert.equal(isMisconfigurationSkip(r), true);
  });
});
