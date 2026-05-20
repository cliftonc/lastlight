import { OpencodeChatServer } from "../src/engine/opencode-chat-server.ts";

const server = new OpencodeChatServer({
  port: 4097,
  workingDir: "/tmp/chat-smoke-wd",
  defaultModel: "openai/gpt-5.3-codex",
  binary: process.cwd() + "/node_modules/.bin/opencode",
  printLogs: process.env.LOGS === "1",
});

try {
  console.log("[smoke] starting…");
  await server.start();
  console.log("[smoke] running, creating session…");
  const sid = await server.createSession({ title: "smoke" });
  console.log("[smoke] sessionId =", sid);
  console.log("[smoke] posting turn 1…");
  const t1 = await server.postMessage(sid, "Reply with exactly the single word: pong", { timeoutMs: 60_000 });
  console.log("[smoke] turn1 text =", JSON.stringify(t1.text));
  console.log("[smoke] turn1 finish =", t1.finish, "tokens.input=", t1.tokens.input);
  console.log("[smoke] posting turn 2 (resume)…");
  const t2 = await server.postMessage(sid, "What was the last word you said?", { timeoutMs: 60_000 });
  console.log("[smoke] turn2 text =", JSON.stringify(t2.text));
  console.log("[smoke] turn2 cache.read =", t2.tokens.cacheRead);
  console.log("[smoke] stopping…");
  await server.stop();
  console.log("[smoke] DONE");
  process.exit(0);
} catch (err) {
  console.error("[smoke] FAIL:", err.message);
  await server.stop().catch(() => {});
  process.exit(1);
}
