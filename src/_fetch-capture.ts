/**
 * Captures Node's built-in `fetch` (and its friends) the moment this
 * module is evaluated — which is BEFORE any other import in
 * `src/index.ts` runs, since this is the first import there.
 *
 * Why this exists: pi-coding-agent (loaded transitively via agentic-pi
 * for sandbox runs) calls `undici.install()` from its bundled, newer
 * undici. That `install()` overwrites `globalThis.fetch` with the
 * bundled version, which is stricter about response headers and
 * rejects GitHub's OAuth token response with
 * `UND_ERR_INVALID_ARG: invalid content-length header` — breaking the
 * admin dashboard's "Sign in with GitHub" flow. The Slack OAuth flow
 * has the same exposure.
 *
 * Capturing here keeps Node's original `fetch` reachable; admin OAuth
 * handlers swap `globalThis.fetch` back to this captured copy for the
 * duration of arctic's `validateAuthorizationCode` call, then restore
 * whatever was there before so workflow / chat fetch paths keep using
 * pi-coding-agent's undici if it has been installed.
 *
 * IMPORTANT: this module MUST have zero imports of its own and MUST be
 * the first import in `src/index.ts`. Adding any other import here, or
 * placing it later in the import order, would let pi-coding-agent's
 * install fire first and break the capture.
 */

export const NODE_BUILTIN_FETCH = globalThis.fetch;
export const NODE_BUILTIN_HEADERS = globalThis.Headers;
export const NODE_BUILTIN_REQUEST = globalThis.Request;
export const NODE_BUILTIN_RESPONSE = globalThis.Response;

/**
 * Run a function with `globalThis.fetch` (and Request/Response/Headers)
 * temporarily restored to Node's built-in implementations, then put
 * them back to whatever they were when the function was entered.
 *
 * Use this around any HTTP call that's sensitive to undici's stricter
 * response validation (e.g. arctic's OAuth token exchanges, which
 * accept whatever GitHub/Slack send and don't care about the
 * content-length pedantry).
 *
 * No-op under vitest: tests intentionally override `global.fetch` with
 * mocks, and the whole point of the restore is to defeat *unwanted*
 * overrides (pi-coding-agent's bundled undici). Detecting the test
 * runner lets the production fix coexist with the existing test
 * pattern unchanged.
 */
const IS_VITEST = typeof process !== "undefined" && process.env?.VITEST === "true";

export async function withNodeBuiltinFetch<T>(fn: () => Promise<T>): Promise<T> {
  if (IS_VITEST) return fn();
  const prevFetch = globalThis.fetch;
  const prevHeaders = globalThis.Headers;
  const prevRequest = globalThis.Request;
  const prevResponse = globalThis.Response;
  globalThis.fetch = NODE_BUILTIN_FETCH;
  globalThis.Headers = NODE_BUILTIN_HEADERS;
  globalThis.Request = NODE_BUILTIN_REQUEST;
  globalThis.Response = NODE_BUILTIN_RESPONSE;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.Headers = prevHeaders;
    globalThis.Request = prevRequest;
    globalThis.Response = prevResponse;
  }
}
