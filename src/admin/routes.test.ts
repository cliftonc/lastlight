import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "./routes.js";
import type { StateDb } from "../state/db.js";
import type { SessionReader } from "./sessions.js";

// Mock docker so tests don't need a running daemon
vi.mock("./docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
}));

// Mock arctic so we control OAuth flow without hitting Slack or GitHub
vi.mock("arctic", () => {
  class Slack {
    createAuthorizationURL(_state: string, _scopes: string[]) {
      return new URL("https://slack.com/openid/connect/authorize?mocked=1");
    }
    async validateAuthorizationCode(_code: string) {
      return { accessToken: () => "mock-slack-access-token" };
    }
  }
  class GitHub {
    createAuthorizationURL(_state: string, _scopes: string[]) {
      return new URL("https://github.com/login/oauth/authorize?mocked=1");
    }
    async validateAuthorizationCode(_code: string) {
      return { accessToken: () => "mock-github-access-token" };
    }
  }
  return { Slack, GitHub };
});

// Minimal mocks
const mockDb = {
  executionStats: vi.fn(() => ({ total: 0, running: 0, success: 0, failed: 0 })),
  dailyStats: vi.fn(() => []),
  hourlyStats: vi.fn(() => []),
  getRateLimits: vi.fn(() => []),
  listSystemStatus: vi.fn(() => []),
  allExecutions: vi.fn(() => []),
  listWorkflowRuns: vi.fn(() => ({ runs: [], total: 0 })),
  distinctWorkflowNames: vi.fn(() => []),
  getWorkflowRun: vi.fn(() => null),
  listPendingApprovals: vi.fn(() => []),
  runningExecutions: vi.fn(() => []),
} as unknown as StateDb;

const mockSessions = {
  listSessionIds: vi.fn(() => []),
  getSessionMeta: vi.fn(async () => null),
  exists: vi.fn(() => false),
  read: vi.fn(async () => []),
  getFilePath: vi.fn(() => null),
} as unknown as SessionReader;

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "test-password",
    adminSecret: "test-secret",
    ...overrides,
  };
}

async function request(app: ReturnType<typeof createAdminRoutes>, path: string, opts: RequestInit = {}) {
  const req = new Request(`http://localhost${path}`, opts);
  return app.fetch(req);
}

describe("GET /auth-required", () => {
  it("returns slackOAuth: false when not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.slackOAuth).toBe(false);
    expect(body.required).toBe(true);
  });

  it("returns slackOAuth: true when client ID and secret are configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.slackOAuth).toBe(true);
  });

  it("returns slackOAuth: false when only clientId is set (secret missing)", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { slackOAuth: boolean };
    expect(body.slackOAuth).toBe(false);
  });
});

describe("GET /oauth/slack/authorize", () => {
  it("returns 404 when Slack OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/slack/authorize");
    expect(res.status).toBe(404);
  });

  it("redirects to Slack when configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));
    const res = await request(app, "/oauth/slack/authorize");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack.com");
  });
});

describe("GET /oauth/slack/callback", () => {
  it("returns 404 when Slack OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/slack/callback?code=abc&state=xyz");
    expect(res.status).toBe(404);
  });

  it("returns 400 when state is missing or mismatched", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));
    // No cookie set → state mismatch
    const res = await request(app, "/oauth/slack/callback?code=abc&state=bad-state");
    expect(res.status).toBe(400);
  });

  it("returns 403 when workspace does not match", async () => {
    // Mock fetch to return a different team
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "U99999",
        "https://slack.com/team_id": "T99999",
        "https://slack.com/team_domain": "other-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
      slackAllowedWorkspace: "T00001",
    }));

    // Simulate request with matching state cookie
    const state = "teststate123";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    global.fetch = originalFetch;
  });

  it("redirects with token when workspace matches by team_id", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "U00001",
        "https://slack.com/team_id": "T00001",
        "https://slack.com/team_domain": "my-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
      slackAllowedWorkspace: "T00001",
    }));

    const state = "teststate456";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });

  it("redirects with token when no workspace restriction set", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "UANY",
        "https://slack.com/team_id": "TANY",
        "https://slack.com/team_domain": "any-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));

    const state = "teststate789";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });
});

describe("GET /auth-required (GitHub OAuth)", () => {
  it("returns githubOAuth: false when not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean; githubOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.githubOAuth).toBe(false);
  });

  it("returns githubOAuth: true when client ID and secret are configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.githubOAuth).toBe(true);
  });

  it("returns githubOAuth: false when only clientId is set (secret missing)", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(body.githubOAuth).toBe(false);
  });
});

describe("GET /oauth/github/authorize", () => {
  it("returns 404 when GitHub OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/github/authorize");
    expect(res.status).toBe(404);
  });

  it("redirects to GitHub when configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
    }));
    const res = await request(app, "/oauth/github/authorize");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com");
  });

  it("sets github_oauth_state cookie when configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
    }));
    const res = await request(app, "/oauth/github/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("github_oauth_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });
});

/** Helper: mock global.fetch routing /user and /orgs/... to different responses */
function mockGithubFetch({ userLogin, orgStatus }: { userLogin: string; orgStatus?: number }) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes("/orgs/")) {
      return new Response(null, { status: orgStatus ?? 204 });
    }
    // Default: /user
    return new Response(
      JSON.stringify({ login: userLogin }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("GET /oauth/github/callback", () => {
  it("returns 404 when GitHub OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/github/callback?code=abc&state=xyz");
    expect(res.status).toBe(404);
  });

  it("returns 400 when state is missing or mismatched", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
    }));
    // No cookie set → state mismatch
    const res = await request(app, "/oauth/github/callback?code=abc&state=bad-state");
    expect(res.status).toBe(400);
  });

  it("returns 400 when code is missing", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
    }));
    const state = "teststate000";
    const req = new Request(`http://localhost/oauth/github/callback?state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("redirects with token when no org restriction set", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockGithubFetch({ userLogin: "alice" });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
    }));

    const state = "teststate111";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });

  it("redirects with token when org membership returns 204", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 204 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate222";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });

  it("returns 403 when org membership returns 404 (not a member)", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 404 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate333";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("org membership required");

    global.fetch = originalFetch;
  });

  it("returns 403 when org membership returns 302 (insufficient visibility)", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 302 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate444";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    global.fetch = originalFetch;
  });
});

describe("POST /login (password)", () => {
  it("still works with correct password", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      adminPassword: "correct",
    }));
    const res = await request(app, "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(typeof body.token).toBe("string");
  });

  it("rejects wrong password", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      adminPassword: "correct",
    }));
    const res = await request(app, "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});
