/**
 * Exa provider. https://docs.exa.ai/
 *
 * Endpoints used:
 *   POST https://api.exa.ai/search    — neural/keyword search
 *   POST https://api.exa.ai/contents  — fetch extracted content for one or more URLs
 *
 * Auth: `x-api-key: <key>`.
 */

import type {
  FetchImpl,
  FetchParams,
  NormalizedFetchResult,
  NormalizedSearchResult,
  Provider,
  SearchParams,
} from "../types.js";

export interface ExaOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

interface ExaSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    score?: number;
    publishedDate?: string;
    text?: string;
  }>;
}

interface ExaContentsResponse {
  results?: Array<{
    url?: string;
    title?: string;
    text?: string;
  }>;
}

export function createExaProvider(options: ExaOptions): Provider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const baseUrl = options.baseUrl ?? "https://api.exa.ai";

  return {
    name: "exa",
    supportsExtractedContent: true,

    async search(params: SearchParams): Promise<NormalizedSearchResult> {
      const body: Record<string, unknown> = {
        query: params.query,
        numResults: params.maxResults,
        type: params.searchDepth === "advanced" ? "neural" : "auto",
      };
      if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
      if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
      if (params.includeContent === true) {
        body.contents = { text: { maxCharacters: 4000 } };
      }

      const r = await fetchImpl(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`exa search failed: http ${r.status} ${text.slice(0, 200)}`);
      }
      const data = (await r.json()) as ExaSearchResponse;
      return {
        provider: "exa",
        query: params.query,
        results: (data.results ?? []).map((it) => ({
          title: it.title ?? "",
          url: it.url ?? "",
          content: it.text,
          score: it.score,
          publishedDate: it.publishedDate,
        })),
      };
    },

    async fetch(params: FetchParams): Promise<NormalizedFetchResult> {
      const r = await fetchImpl(`${baseUrl}/contents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify({
          urls: [params.url],
          text: true,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`exa contents failed: http ${r.status} ${text.slice(0, 200)}`);
      }
      const data = (await r.json()) as ExaContentsResponse;
      const hit = data.results?.[0];
      if (!hit?.text) {
        throw new Error(`exa contents returned no text for ${params.url}`);
      }
      return {
        provider: "exa",
        url: params.url,
        resolvedUrl: hit.url,
        text: hit.text,
        title: hit.title,
      };
    },
  };
}
