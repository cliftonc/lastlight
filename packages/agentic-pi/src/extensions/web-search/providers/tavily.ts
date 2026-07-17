/**
 * Tavily provider. https://docs.tavily.com/
 *
 * Endpoints used:
 *   POST https://api.tavily.com/search   — ranked links + optional content + optional answer
 *   POST https://api.tavily.com/extract  — bulk fetch + extracted text for a list of URLs
 *
 * API key passed as `api_key` in the JSON body (Tavily's documented
 * convention; the Bearer header is rejected on /search).
 */

import type {
  FetchImpl,
  FetchParams,
  NormalizedFetchResult,
  NormalizedSearchResult,
  Provider,
  SearchParams,
} from "../types.js";

export interface TavilyOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** Override for tests. */
  baseUrl?: string;
}

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string | null;
    score?: number;
    published_date?: string;
  }>;
}

interface TavilyExtractResponse {
  results?: Array<{
    url?: string;
    raw_content?: string;
    title?: string;
  }>;
  failed_results?: Array<{ url?: string; error?: string }>;
}

export function createTavilyProvider(options: TavilyOptions): Provider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const baseUrl = options.baseUrl ?? "https://api.tavily.com";

  return {
    name: "tavily",
    supportsExtractedContent: true,

    async search(params: SearchParams): Promise<NormalizedSearchResult> {
      const body: Record<string, unknown> = {
        api_key: options.apiKey,
        query: params.query,
        max_results: params.maxResults,
        search_depth: params.searchDepth === "advanced" ? "advanced" : "basic",
        include_answer: true,
        include_raw_content: params.includeContent === true,
      };
      if (params.includeDomains?.length) body.include_domains = params.includeDomains;
      if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;

      const r = await fetchImpl(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`tavily search failed: http ${r.status} ${text.slice(0, 200)}`);
      }
      const data = (await r.json()) as TavilyResponse;
      return {
        provider: "tavily",
        query: data.query ?? params.query,
        answer: data.answer,
        results: (data.results ?? []).map((it) => ({
          title: it.title ?? "",
          url: it.url ?? "",
          snippet: it.content,
          content: it.raw_content ?? undefined,
          score: it.score,
          publishedDate: it.published_date,
        })),
      };
    },

    async fetch(params: FetchParams): Promise<NormalizedFetchResult> {
      const r = await fetchImpl(`${baseUrl}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: options.apiKey,
          urls: [params.url],
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`tavily extract failed: http ${r.status} ${text.slice(0, 200)}`);
      }
      const data = (await r.json()) as TavilyExtractResponse;
      const hit = data.results?.[0];
      if (!hit?.raw_content) {
        const fail = data.failed_results?.[0];
        throw new Error(
          fail?.error
            ? `tavily extract returned no content for ${params.url}: ${fail.error}`
            : `tavily extract returned no content for ${params.url}`,
        );
      }
      return {
        provider: "tavily",
        url: params.url,
        resolvedUrl: hit.url,
        text: hit.raw_content,
        title: hit.title,
      };
    },
  };
}
