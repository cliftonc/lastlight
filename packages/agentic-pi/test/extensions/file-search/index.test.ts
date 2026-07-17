import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  loadFileSearchExtension,
  isMisconfigurationSkip,
  DEFAULT_FILE_SEARCH_MODE,
} from "../../../src/extensions/file-search/index.js";

describe("loadFileSearchExtension", () => {
  test("default: configured in override mode with builtin tool names", () => {
    const r = loadFileSearchExtension();
    assert.equal(r.status, "configured");
    assert.equal(r.mode, "override");
    assert.equal(DEFAULT_FILE_SEARCH_MODE, "override");
    assert.deepEqual(r.toolNames, ["find", "grep", "multi_grep"]);
    assert.ok(r.packageDir, "packageDir should be resolved");
    assert.ok(
      existsSync(join(r.packageDir!, "package.json")),
      "packageDir should contain package.json",
    );
    assert.equal(isMisconfigurationSkip(r), false);
  });

  test("fileSearch:false → disabled-by-flag skip (silent)", () => {
    const r = loadFileSearchExtension({ fileSearch: false });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "disabled-by-flag");
    assert.deepEqual(r.toolNames, []);
    assert.equal(r.packageDir, undefined);
    assert.equal(isMisconfigurationSkip(r), false);
  });

  test("tools-only mode → fff-prefixed tool names", () => {
    const r = loadFileSearchExtension({ fileSearchMode: "tools-only" });
    assert.equal(r.status, "configured");
    assert.equal(r.mode, "tools-only");
    assert.deepEqual(r.toolNames, ["fffind", "ffgrep", "fff-multi-grep"]);
  });

  test("resolve failure → resolve-failed skip flagged as misconfiguration", () => {
    const r = loadFileSearchExtension({
      resolvePackageDir: () => {
        throw new Error("Cannot find module");
      },
    });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "resolve-failed");
    assert.match(r.message ?? "", /Cannot find module/);
    assert.deepEqual(r.toolNames, []);
    assert.equal(isMisconfigurationSkip(r), true);
  });
});
