import { describe, it, expect, vi } from "vitest";
import { createAdminRoutes, type AdminConfig } from "./routes.js";
import { createToken } from "./auth.js";
import type { StateDb } from "../state/db.js";
import type { SessionReader } from "./sessions.js";

vi.mock("./docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
}));
vi.mock("arctic", () => ({ Slack: class {}, GitHub: class {} }));

const SECRET = "test-secret";

function makeDb(searchErrors: (...args: any[]) => any[] = () => []) {
  return {
    executions: { searchErrors },
    runs: {},
    approvals: {},
  } as unknown as StateDb;
}

function makeSessions(opts: {
  ids?: string[];
  read?: (id: string) => Promise<Array<{ index: number; msg: Record<string, unknown> }>>;
} = {}) {
  return {
    listSessionIds: vi.fn(() => opts.ids ?? []),
    read: vi.fn(opts.read ?? (async () => [])),
    getSessionMeta: vi.fn(async () => null),
    exists: vi.fn(() => false),
    getFilePath: vi.fn(() => null),
    normalizeRawLine: vi.fn((raw: Record<string, unknown>) => [raw]),
  } as unknown as SessionReader;
}

function makeConfig(): AdminConfig {
  return { stateDir: "/tmp", sessionsDir: "/tmp/s", adminPassword: "pw", adminSecret: SECRET };
}

function authed(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${createToken(SECRET)}` },
  });
}

describe("GET /log-search", () => {
  it("401s without a token", async () => {
    const app = createAdminRoutes(makeDb(), makeSessions(), makeSessions(), makeConfig());
    const res = await app.fetch(new Request("http://localhost/log-search?q=boom"));
    expect(res.status).toBe(401);
  });

  it("400s when q is missing", async () => {
    const app = createAdminRoutes(makeDb(), makeSessions(), makeSessions(), makeConfig());
    const res = await app.fetch(authed("/log-search"));
    expect(res.status).toBe(400);
  });

  it("returns error-scope matches from the executions ledger", async () => {
    const searchErrors = vi.fn(() => [
      { id: "e1", skill: "pr-review:review", repo: "o/r", error: "boom failed", success: false, startedAt: "2026-01-01T00:00:00Z", sessionId: "ses_1", workflowRunId: "wf_1", triggerId: "t1" },
    ]);
    const app = createAdminRoutes(makeDb(searchErrors), makeSessions(), makeSessions(), makeConfig());
    const res = await app.fetch(authed("/log-search?q=boom&limit=10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(searchErrors).toHaveBeenCalledWith("boom", 10);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ source: "error", executionId: "e1", sessionId: "ses_1", snippet: "boom failed" });
  });

  it("greps transcripts in messages scope", async () => {
    const sessions = makeSessions({
      ids: ["ses_a"],
      read: async () => [
        { index: 0, msg: { role: "user", content: "please fix the flaky test" } },
        { index: 1, msg: { role: "assistant", content: "the flaky retry logic is here" } },
      ],
    });
    const app = createAdminRoutes(makeDb(), sessions, makeSessions(), makeConfig());
    const res = await app.fetch(authed("/log-search?q=flaky&scope=messages"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(body.results.length).toBe(2);
    expect(body.results[0]).toMatchObject({ source: "message", sessionId: "ses_a" });
    expect(body.results[0].snippet.toLowerCase()).toContain("flaky");
  });
});
