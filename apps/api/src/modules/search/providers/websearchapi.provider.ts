import {
  ProviderRateLimitError,
  ProviderRequestError,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from './types';

/**
 * WebSearchAPI.ai — SERP-style web search API.
 * Search: https://api.websearchapi.ai/v1/search
 * Auth: Bearer token (X-API-Key also accepted by some plans). Free tier
 * provides a monthly request allowance.
 *
 * Note: confirm the exact base path/param names against your account's
 * dashboard; they are isolated here so only this file changes if they differ.
 */
export class WebSearchApiProvider implements SearchProvider {
  readonly name = 'websearchapi';
  readonly capabilities = {
    search: true,
    scrape: false,
    searchTypes: ['general', 'news'] as const,
  };

  constructor(
    private readonly apiKey = process.env.WEBSEARCHAPI_AI_KEY ?? '',
    private readonly baseUrl = process.env.WEBSEARCHAPI_AI_BASE_URL ??
      'https://api.websearchapi.ai/v1/search',
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const params = new URLSearchParams({
      q: req.query,
      num: String(req.maxResults ?? 10),
    });
    if (req.searchType === 'news') params.set('type', 'news');

    const res = await fetch(`${this.baseUrl}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-API-Key': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'websearchapi 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    // Be liberal in what shapes we accept.
    const raw: any[] = data.results ?? data.organic ?? data.data ?? data.items ?? [];
    return {
      provider: this.name,
      query: req.query,
      results: raw.slice(0, req.maxResults ?? 10).map((r) => ({
        title: r.title ?? r.name ?? '',
        url: r.url ?? r.link ?? '',
        snippet: r.snippet ?? r.description ?? r.content ?? '',
        publishedDate: r.date ?? r.published_date ?? null,
      })),
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
