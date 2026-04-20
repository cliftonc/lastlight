import crypto from "node:crypto";
import type { Context, Next } from "hono";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function createToken(secret: string, method?: "password" | "slack" | "github"): string {
  const payload: { exp: number; method?: string } = { exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  if (method) payload.method = method;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (
    expectedSig.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number") return false;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

export function authMiddleware(password: string, secret: string) {
  const enabled = Boolean(password);

  return async (c: Context, next: Next) => {
    if (!enabled) return next();

    const path = new URL(c.req.url).pathname;
    // Let login + health + OAuth routes through
    if (
      path.endsWith("/login") ||
      path.endsWith("/health") ||
      path.endsWith("/auth-required") ||
      path.endsWith("/oauth/slack/authorize") ||
      path.endsWith("/oauth/slack/callback") ||
      path.endsWith("/oauth/github/authorize") ||
      path.endsWith("/oauth/github/callback")
    ) {
      return next();
    }

    const header = c.req.header("Authorization");
    let token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    // EventSource can't set headers — allow token via query param
    if (!token) token = c.req.query("token") ?? undefined;

    if (!token || !verifyToken(token, secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
