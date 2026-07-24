import { describe, it, expect, vi } from "vitest";
import { GitHubClient, actionsJobIdFromDetailsUrl, extractErrorExcerpt } from "#src/engine/github/github.js";

/**
 * Unit coverage for `getFailedChecks`, `actionsJobIdFromDetailsUrl`, and
 * `extractErrorExcerpt`.
 *
 * Swap pattern mirrors github-checks.test.ts.
 */

type CheckRun = {
  id: number;
  name: string;
  conclusion: string;
  details_url?: string | null;
};

type Annotation = {
  annotation_level: string;
  path: string;
  start_line: number;
  message: string;
};

function makeOctokit(opts: {
  checkRuns: CheckRun[];
  logData?: string | Error;
  annotations?: Annotation[];
}) {
  const downloadFn = vi.fn(async () => {
    if (opts.logData instanceof Error) throw opts.logData;
    return { data: opts.logData ?? "" };
  });
  return {
    downloadFn,
    octokit: {
      rest: {
        checks: {
          listForRef: async () => ({ data: { check_runs: opts.checkRuns } }),
          listAnnotations: async () => ({
            data: opts.annotations ?? [],
          }),
        },
        actions: {
          downloadJobLogsForWorkflowRun: downloadFn,
        },
      },
    },
  };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { octokit: unknown }).octokit = octokit;
  return c;
}

// ---------------------------------------------------------------------------
// actionsJobIdFromDetailsUrl — pure unit tests
// ---------------------------------------------------------------------------

describe("actionsJobIdFromDetailsUrl", () => {
  it("extracts the job id from a standard Actions details_url", () => {
    expect(
      actionsJobIdFromDetailsUrl(
        "https://github.com/nearform/repo/actions/runs/12345/job/456"
      )
    ).toBe(456);
  });

  it("returns null for a URL without /job/", () => {
    expect(actionsJobIdFromDetailsUrl("https://circleci.com/gh/org/repo/789")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(actionsJobIdFromDetailsUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(actionsJobIdFromDetailsUrl(undefined)).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(actionsJobIdFromDetailsUrl("not-a-url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractErrorExcerpt — pure unit tests
// ---------------------------------------------------------------------------

describe("extractErrorExcerpt", () => {
  it("strips leading ISO-8601 timestamps", () => {
    const log = "2026-07-24T06:04:28.1234567Z error: something went wrong\n";
    const result = extractErrorExcerpt(log);
    expect(result).toContain("error: something went wrong");
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("returns context lines around a real error line", () => {
    const lines = [
      "2026-07-24T06:04:00.000Z info: start",
      "2026-07-24T06:04:01.000Z info: running build",
      "2026-07-24T06:04:02.000Z error: Cannot find module 'postcss-import'",
      "2026-07-24T06:04:03.000Z info: done",
    ];
    const result = extractErrorExcerpt(lines.join("\n"));
    expect(result).toContain("Cannot find module 'postcss-import'");
    expect(result).toContain("info: start");
  });

  it("does not anchor on pure noise lines", () => {
    const lines = [
      "2026-07-24T06:04:01.000Z error: real failure here",
      "2026-07-24T06:04:02.000Z Process completed with exit code 1",
    ];
    const result = extractErrorExcerpt(lines.join("\n"));
    // Must contain the real error, not be dominated by the noise line
    expect(result).toContain("real failure here");
  });

  it("surfaces noise-only logs rather than returning empty", () => {
    const log = "2026-07-24T06:04:02.000Z Process completed with exit code 1\n";
    const result = extractErrorExcerpt(log);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it("falls back to tail lines when no error lines found", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `2026-01-01T00:00:00.000Z info: line ${i}`);
    const result = extractErrorExcerpt(lines.join("\n"));
    expect(result.trim().length).toBeGreaterThan(0);
    // Should not contain timestamps
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// getFailedChecks — integration-style tests with fake octokit
// ---------------------------------------------------------------------------

describe("GitHubClient.getFailedChecks", () => {
  it("returns sentinel when there are no failed checks", async () => {
    const { octokit } = makeOctokit({ checkRuns: [] });
    const c = clientWith(octokit);
    expect(await c.getFailedChecks("o", "r", "sha")).toBe("No failed checks found.");
  });

  it("uses the job id from details_url, not run.id", async () => {
    const LOG = [
      "2026-07-24T06:04:00.000Z ##[group]Run npm run build",
      "2026-07-24T06:04:01.000Z > vite build",
      "2026-07-24T06:04:02.000Z error [postcss]: Cannot find module 'postcss-import'",
      "2026-07-24T06:04:03.000Z Process completed with exit code 1",
    ].join("\n");

    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 999, // run.id — must NOT be used as job_id
          name: "CI / build",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/12345/job/456",
        },
      ],
      logData: LOG,
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    // Must have called download with the correct job id (456), not run.id (999)
    expect(downloadFn).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 456 })
    );

    // The excerpt must surface the real PostCSS error, not just "Process completed"
    expect(result).toContain("postcss-import");
    expect(result).not.toBe("Process completed with exit code 1");

    // Timestamps must be stripped
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);

    // Section header must be present
    expect(result).toContain("### CI / build: failure");
  });

  it("falls back to annotations when log download rejects", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 10,
          name: "CI / test",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/1/job/2",
        },
      ],
      logData: new Error("404 Not Found"),
      annotations: [
        {
          annotation_level: "failure",
          path: "src/index.ts",
          start_line: 42,
          message: "Unexpected token",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / test: failure");
    expect(result).toContain("src/index.ts:42");
    expect(result).toContain("Unexpected token");
  });

  it("skips log download when details_url is null (non-Actions check)", async () => {
    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 20,
          name: "CircleCI",
          conclusion: "failure",
          details_url: null,
        },
      ],
      annotations: [
        {
          annotation_level: "failure",
          path: ".github/ci.yml",
          start_line: 77,
          message: "Process completed with exit code 1",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    // Log download must never have been attempted
    expect(downloadFn).not.toHaveBeenCalled();

    // Should still show the annotation
    expect(result).toContain("### CircleCI: failure");
    expect(result).toContain(".github/ci.yml:77");
  });

  it("skips log download when details_url has no /job/ segment", async () => {
    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 30,
          name: "External",
          conclusion: "failure",
          details_url: "https://circleci.com/gh/org/repo/999",
        },
      ],
      annotations: [],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(downloadFn).not.toHaveBeenCalled();
    expect(result).toContain("### External: failure");
  });

  it("surfaces noise-only log rather than an empty excerpt", async () => {
    const LOG = "2026-07-24T06:04:02.000Z Process completed with exit code 1\n";

    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 40,
          name: "CI / lint",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/1/job/2",
        },
      ],
      logData: LOG,
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / lint: failure");
    // Should have SOME content (not just "No log details available.")
    const body = result.split("\n").slice(1).join("\n").trim();
    expect(body.length).toBeGreaterThan(0);
  });

  it("falls back to warning-level annotations when no failure-level ones exist", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 50,
          name: "CI / typecheck",
          conclusion: "failure",
          details_url: null,
        },
      ],
      annotations: [
        {
          annotation_level: "warning",
          path: "src/foo.ts",
          start_line: 5,
          message: "Unused variable",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / typecheck: failure");
    expect(result).toContain("src/foo.ts:5");
    expect(result).toContain("Unused variable");
  });
});
