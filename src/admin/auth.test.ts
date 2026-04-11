import { describe, it, expect } from "vitest";
import { createToken, verifyToken } from "./auth.js";

const SECRET = "test-secret-key";

describe("createToken / verifyToken", () => {
  it("creates a valid token and verifies it", () => {
    const token = createToken(SECRET);
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("creates a token with method=password and verifies it", () => {
    const token = createToken(SECRET, "password");
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("creates a token with method=slack and verifies it", () => {
    const token = createToken(SECRET, "slack");
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createToken(SECRET, "slack");
    expect(verifyToken(token, "wrong-secret")).toBe(false);
  });

  it("backward compat: tokens without method field still verify", async () => {
    // Manually craft a token without method field (old format)
    const crypto = await import("node:crypto");
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = createToken(SECRET, "slack");
    const tampered = token.slice(0, -2) + "xx";
    expect(verifyToken(tampered, SECRET)).toBe(false);
  });

  it("rejects a token with wrong part count", () => {
    expect(verifyToken("notavalidtoken", SECRET)).toBe(false);
  });
});
