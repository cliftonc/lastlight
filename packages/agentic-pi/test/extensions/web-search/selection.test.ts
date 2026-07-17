import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  selectProvider,
  isProviderName,
  PROVIDER_ENV_VAR,
} from "../../../src/extensions/web-search/selection.js";

describe("selectProvider", () => {
  test("disabled-by-flag short-circuits even when keys are set", () => {
    const r = selectProvider({
      webSearch: false,
      env: { TAVILY_API_KEY: "tvly-xxx" },
    });
    assert.equal(r.status, "skipped");
    if (r.status === "skipped") assert.equal(r.reason, "disabled-by-flag");
  });

  test("no keys present → silent no-credentials skip", () => {
    const r = selectProvider({ webSearch: true, env: {} });
    assert.equal(r.status, "skipped");
    if (r.status === "skipped") {
      assert.equal(r.reason, "no-credentials");
      assert.equal(r.provider, undefined);
      assert.equal(r.message, undefined);
    }
  });

  test("single Tavily key auto-selects Tavily", () => {
    const r = selectProvider({
      webSearch: true,
      env: { TAVILY_API_KEY: "tvly-abc" },
    });
    assert.equal(r.status, "configured");
    if (r.status === "configured") {
      assert.equal(r.provider, "tavily");
      assert.equal(r.apiKey, "tvly-abc");
      assert.equal(r.message, undefined);
    }
  });

  test("priority is Tavily > Exa > Brave when multiple keys are set", () => {
    const r = selectProvider({
      webSearch: true,
      env: {
        TAVILY_API_KEY: "tvly-x",
        EXA_API_KEY: "exa-x",
        BRAVE_SEARCH_API_KEY: "brv-x",
      },
    });
    assert.equal(r.status, "configured");
    if (r.status === "configured") {
      assert.equal(r.provider, "tavily");
      assert.ok(r.message?.includes("tavily"));
      assert.ok(r.message?.includes("override"));
    }

    const r2 = selectProvider({
      webSearch: true,
      env: { EXA_API_KEY: "exa-x", BRAVE_SEARCH_API_KEY: "brv-x" },
    });
    if (r2.status === "configured") assert.equal(r2.provider, "exa");
  });

  test("explicit provider via config wins over env priority", () => {
    const r = selectProvider({
      webSearch: true,
      webSearchProvider: "brave",
      env: {
        TAVILY_API_KEY: "tvly-x",
        BRAVE_SEARCH_API_KEY: "brv-x",
      },
    });
    assert.equal(r.status, "configured");
    if (r.status === "configured") {
      assert.equal(r.provider, "brave");
      assert.equal(r.apiKey, "brv-x");
    }
  });

  test("explicit provider via WEB_SEARCH_PROVIDER env wins over auto", () => {
    const r = selectProvider({
      webSearch: true,
      env: {
        WEB_SEARCH_PROVIDER: "exa",
        TAVILY_API_KEY: "tvly-x",
        EXA_API_KEY: "exa-x",
      },
    });
    if (r.status === "configured") assert.equal(r.provider, "exa");
  });

  test("explicit provider with missing key surfaces a warning skip", () => {
    const r = selectProvider({
      webSearch: true,
      webSearchProvider: "brave",
      env: { TAVILY_API_KEY: "tvly-x" },
    });
    assert.equal(r.status, "skipped");
    if (r.status === "skipped") {
      assert.equal(r.reason, "no-credentials");
      assert.equal(r.provider, "brave");
      assert.ok(r.message?.includes(PROVIDER_ENV_VAR.brave));
    }
  });

  test("unknown explicit provider name throws (config error)", () => {
    assert.throws(
      () =>
        selectProvider({
          webSearch: true,
          webSearchProvider: "google",
          env: {},
        }),
      /Unknown web-search provider 'google'/,
    );
  });

  test("blank/whitespace keys are not considered present", () => {
    const r = selectProvider({
      webSearch: true,
      env: { TAVILY_API_KEY: "   " },
    });
    assert.equal(r.status, "skipped");
  });
});

describe("isProviderName", () => {
  test("accepts the three valid names", () => {
    assert.ok(isProviderName("tavily"));
    assert.ok(isProviderName("brave"));
    assert.ok(isProviderName("exa"));
  });
  test("rejects anything else", () => {
    for (const bad of ["", "TAVILY", "google", "perplexity"]) {
      assert.ok(!isProviderName(bad));
    }
  });
});
