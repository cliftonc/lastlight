import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLog, projectSlugForCwd } from "#src/session-log.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function makeLog(): Promise<{ homeDir: string; log: SessionLog }> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-test-"));
  tmpDirs.push(homeDir);
  return { homeDir, log: new SessionLog(homeDir) };
}

describe("SessionLog", () => {
  it("round-trips appended envelope lines as normalized messages", async () => {
    const { log } = await makeLog();
    const ref = { projectSlug: projectSlugForCwd("/home/agent/workspace"), sessionId: "sess1" };
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-01T00:00:01.000Z";
    const t3 = "2026-01-01T00:00:02.000Z";

    await log.appendEnvelopeLines(ref, [
      { type: "user", message: { role: "user", content: "hello" }, timestamp: t1, sessionId: ref.sessionId },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hi there" },
            { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
          ],
        },
        timestamp: t2,
        sessionId: ref.sessionId,
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }],
        },
        timestamp: t3,
        sessionId: ref.sessionId,
      },
    ]);

    const messages = await log.readNormalizedSession("sandbox", ref.sessionId);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ index: 0, msg: { role: "user", content: "hello", timestamp: t1 } });
    expect(messages[1]!.msg).toMatchObject({
      role: "assistant",
      content: "hi there",
      timestamp: t2,
      tool_calls: [{ id: "tool-1", function: { name: "read", arguments: { path: "README.md" } } }],
    });
    expect(messages[2]).toEqual({
      index: 2,
      msg: { role: "tool", content: "file contents", tool_call_id: "tool-1", timestamp: t3 },
    });
  });

  it("normalizes legacy role-based records", async () => {
    const { log } = await makeLog();
    const ref = { projectSlug: projectSlugForCwd("/home/agent/workspace"), sessionId: "legacy1" };
    const timestamp = "2026-01-02T00:00:00.000Z";
    await log.appendEnvelopeLines(ref, [{ role: "assistant", content: "legacy assistant", timestamp }]);

    const messages = await log.readNormalizedSession("sandbox", ref.sessionId);
    expect(messages).toEqual([
      { index: 0, msg: { role: "assistant", content: "legacy assistant", timestamp } },
    ]);
  });

  it("owns project slugs, paths, and session id validation", async () => {
    const { homeDir, log } = await makeLog();
    const projectSlug = projectSlugForCwd("/home/agent/workspace");
    expect(projectSlug).toBe("-home-agent-workspace");

    expect(log.normalizeSessionId("sess1")).toBe("sess1");
    expect(log.normalizeSessionId("../bad")).toBeNull();
    expect(log.normalizeSessionId("bad.jsonl")).toBeNull();

    const resolved = log.pathForProject(projectSlug, "sess1", { requireExists: false });
    expect(resolved).toBe(path.join(homeDir, "projects", projectSlug, "sess1.jsonl"));
    expect(log.pathForProject(projectSlug, "../bad", { requireExists: false })).toBeNull();
    expect(log.pathForProject(projectSlug, "bad.jsonl", { requireExists: false })).toBeNull();
  });
});
