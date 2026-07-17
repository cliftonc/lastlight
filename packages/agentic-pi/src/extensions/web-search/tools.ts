/**
 * Native Pi tools `web_search` and `web_fetch`.
 *
 * Both tools follow the GitHub-extension convention: errors return a
 * structured JSON payload (instead of throwing) and the JSON payload is
 * stuffed into a single text content block via `jsonContent`. The agent
 * sees the active provider name in every result so it can attribute
 * findings.
 */

import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { extractTitle, htmlToText } from "./extract.js";
import type { RateLimiter } from "./rate-limit.js";
import { safeFetch, SafeFetchError } from "./safe-fetch.js";
import type { Provider } from "./types.js";

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
  };
}

function errorPayload(provider: string, err: unknown, hint?: string) {
  const e = err as Error & { status?: number; code?: string };
  return {
    error: e?.message ?? String(err),
    provider,
    code: e?.code,
    status: e?.status,
    hint: hint ?? null,
  };
}

function rateLimitPayload(provider: string) {
  return {
    error: "web-search rate limit reached for this run",
    provider,
    code: "rate-limited",
    hint:
      "Increase the budget with --web-search-max-calls (CLI) or webSearchMaxCalls (run options), " +
      "or summarize earlier findings instead of searching again.",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildWebSearchTools(
  provider: Provider,
  limiter: RateLimiter,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ToolDefinition<any>[] {
  const searchSchema = Type.Object({
    query: Type.String({ description: "Search query", minLength: 1 }),
    max_results: Type.Optional(
      Type.Integer({
        description: `Max results to return (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`,
        minimum: 1,
        maximum: MAX_RESULTS,
      }),
    ),
    include_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only return results whose URL host matches one of these domains.",
      }),
    ),
    exclude_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Drop results whose URL host matches any of these domains.",
      }),
    ),
    search_depth: Type.Optional(
      Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
        description: "Advisory: providers that support a depth knob honor it; Brave ignores.",
      }),
    ),
    include_content: Type.Optional(
      Type.Boolean({
        description:
          "Ask the provider to return extracted page content inline when supported (Tavily, Exa). Brave ignores.",
      }),
    ),
  });

  const fetchSchema = Type.Object({
    url: Type.String({
      description: "Absolute http:// or https:// URL to download and extract readable text from.",
    }),
  });

  type SearchInput = Static<typeof searchSchema>;
  type FetchInput = Static<typeof fetchSchema>;

  const searchTool = defineTool({
    name: "web_search",
    label: "web_search",
    description:
      `Search the web via ${provider.name}. Returns a ranked list of {title, url, snippet, ...} ` +
      `entries plus (for some providers) an optional 'answer' summary. Use this when you need ` +
      `external context not available in the local workspace.`,
    parameters: searchSchema,
    async execute(_id, params: SearchInput) {
      if (!limiter.consume()) {
        return jsonContent(rateLimitPayload(provider.name));
      }
      const max = Math.min(MAX_RESULTS, params.max_results ?? DEFAULT_RESULTS);
      try {
        const result = await provider.search({
          query: params.query,
          maxResults: max,
          includeDomains: params.include_domains,
          excludeDomains: params.exclude_domains,
          searchDepth: params.search_depth,
          includeContent: params.include_content,
        });
        return jsonContent(result);
      } catch (err) {
        return jsonContent(errorPayload(provider.name, err));
      }
    },
  });

  const fetchTool = defineTool({
    name: "web_fetch",
    label: "web_fetch",
    description:
      `Download a single web page (http/https only) and return its extracted readable text. ` +
      `Uses ${provider.fetch ? `${provider.name}'s content endpoint` : "a generic safe-fetch with HTML stripping"}. ` +
      `Body is capped at ~1 MiB and extracted text at ~200 KiB.`,
    parameters: fetchSchema,
    async execute(_id, params: FetchInput) {
      if (!limiter.consume()) {
        return jsonContent(rateLimitPayload(provider.name));
      }
      try {
        if (provider.fetch) {
          const result = await provider.fetch({ url: params.url });
          return jsonContent(result);
        }
        const r = await safeFetch(params.url);
        const text = htmlToText(r.body);
        const title = extractTitle(r.body);
        return jsonContent({
          provider: "safe-fetch",
          url: params.url,
          resolvedUrl: r.finalUrl,
          status: r.status,
          contentType: r.contentType,
          title,
          text,
        });
      } catch (err) {
        const code = err instanceof SafeFetchError ? err.code : undefined;
        return jsonContent({
          ...errorPayload(provider.name, err),
          code: code ?? (err as { code?: string })?.code,
        });
      }
    },
  });

  return [searchTool, fetchTool];
}
