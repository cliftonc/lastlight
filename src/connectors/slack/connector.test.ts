import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { SlackConnector, verifySlackSignature } from "./connector.js";
import { SessionManager } from "../messaging/session-manager.js";
import type { EventEnvelope } from "../types.js";

function sign(secret: string, ts: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  const secret = "shhh-signing-secret";
  const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
  const now = 1_700_000_000_000; // fixed clock (ms)
  const ts = String(Math.floor(now / 1000));

  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackSignature(body, ts, sign(secret, ts, body), secret, now)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySlackSignature(body, ts, sign("other-secret", ts, body), secret, now)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifySlackSignature(body + "x", ts, sign(secret, ts, body), secret, now)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const stale = String(Math.floor(now / 1000) - 600); // 10 minutes old
    expect(verifySlackSignature(body, stale, sign(secret, stale, body), secret, now)).toBe(false);
  });

  it("rejects missing signature or timestamp", () => {
    expect(verifySlackSignature(body, "", "", secret, now)).toBe(false);
    expect(verifySlackSignature(body, ts, "", secret, now)).toBe(false);
  });
});

describe("SlackConnector webhook receiver", () => {
  const secret = "shhh-signing-secret";
  let app: Hono;
  let conn: SlackConnector;
  let db: Database.Database;
  let events: EventEnvelope[];

  function headers(body: string): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(secret, ts, body),
    };
  }

  const post = (body: string, hdrs?: Record<string, string>) =>
    app.request("/webhooks/slack", { method: "POST", headers: hdrs ?? headers(body), body });

  beforeEach(() => {
    app = new Hono();
    db = new Database(":memory:");
    const sm = new SessionManager(db);
    conn = new SlackConnector(
      {
        botToken: "xoxb-test",
        mode: "webhook",
        signingSecret: secret,
        honoApp: app,
        allowedUsers: [],
        botIdentifier: "",
      },
      sm,
    );
    // Stub the Web API client so nothing hits the network during processing.
    (conn as any).web = {
      users: { info: async () => ({ user: { name: "alice" } }) },
      assistant: { threads: { setStatus: async () => {} } },
      reactions: { add: async () => {} },
      chat: { postMessage: async () => ({ ts: "x" }), update: async () => {} },
    };
    events = [];
    conn.on("event", (e: EventEnvelope) => events.push(e));
  });

  afterEach(() => db.close());

  it("answers the url_verification handshake", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects a request with a bad signature", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body, {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=deadbeef",
    });
    expect(res.status).toBe(401);
  });

  it("acks and emits an EventEnvelope for a DM message event", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "1.1", text: "hello" },
    });
    const res = await post(body);
    expect(res.status).toBe(200);

    // Processing is async (setImmediate) — let it run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("slack");
    expect(events[0].body).toBe("hello");
  });

  it("dedupes Slack retries by event_id", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-dup",
      event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "2.2", text: "once" },
    });

    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);

    // Same event_id again (a Slack retry) → acked but NOT reprocessed.
    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
  });

  it("ignores message subtypes and bot messages", async () => {
    const edited = JSON.stringify({
      type: "event_callback",
      event_id: "Ev2",
      event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", user: "U1", ts: "3.3", text: "edit" },
    });
    const bot = JSON.stringify({
      type: "event_callback",
      event_id: "Ev3",
      event: { type: "message", channel: "D1", channel_type: "im", bot_id: "B1", ts: "4.4", text: "from a bot" },
    });
    await post(edited);
    await post(bot);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
  });
});
