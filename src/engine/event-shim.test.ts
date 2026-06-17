import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgenticShim, projectSlugForCwd } from "./event-shim.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function makeShim(initialPrompt = "do the thing") {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "shim-test-"));
  tmpDirs.push(homeDir);
  const cwd = "/home/agent/workspace";
  const shim = new AgenticShim({
    homeDir,
    projectSlug: projectSlugForCwd(cwd),
    model: "openai/gpt-5.5",
    initialPrompt,
  });
  const filePath = path.join(homeDir, "projects", projectSlugForCwd(cwd), "sess1.jsonl");
  return { shim, filePath };
}

async function readEnvelopes(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("AgenticShim per-message usage", () => {
  it("writes Claude-shaped usage onto the assistant envelope", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input: 1200,
          output: 340,
          cacheRead: 5000,
          cacheWrite: 10,
          cost: { total: 0.07 },
        },
      },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    expect(assistant).toBeDefined();
    const message = assistant?.message as { usage?: Record<string, number> };
    expect(message.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 10,
    });
  });

  it("writes an extension_status event as a system envelope line", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "extension_status",
      sessionId: "sess1",
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const sys = envelopes.find(
      (e) => e.type === "system" && e.subtype === "extension_status",
    );
    expect(sys).toBeDefined();
    expect(sys).toMatchObject({
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    // The initial user (prompt) line precedes it — extension status lands near
    // the top of the session log.
    expect(envelopes[0]?.type).toBe("user");
  });

  it("omits the usage block when the message carries no usage", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    const message = assistant?.message as { usage?: unknown };
    expect(message.usage).toBeUndefined();
  });
});
