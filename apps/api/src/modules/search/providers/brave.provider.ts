import {
  ProviderRateLimitError,
  ProviderRequestError,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from './types';

/**
 * Brave Search API — independent web index.
 * Search: https://api.search.brave.com/res/v1/web/search (also /news/search)
 * Auth: X-Subscription-Token header. Free tier: monthly request allowance.
 */
export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  readonly capabilities = {
    search: true,
    scrape: false,
    searchTypes: ['general', 'news'] as const,
  };

  constructor(private readonly apiKey = process.env.BRAVE_SEARCH_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const endpoint =
      req.searchType === 'news'
        ? 'https://api.search.brave.com/res/v1/news/search'
        : 'https://api.search.brave.com/res/v1/web/search';

    const params = new URLSearchParams({
      q: buildQuery(req),
      count: String(req.maxResults ?? 10),
    });
    const freshness = mapFreshness(req.timeRange);
    if (freshness) params.set('freshness', freshness);

    const res = await fetch(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'brave 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const raw: any[] = data.web?.results ?? data.results ?? [];
    return {
      provider: this.name,
      query: req.query,
      results: raw.slice(0, req.maxResults ?? 10).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? r.snippet ?? '',
        publishedDate: r.age ?? r.page_age ?? null,
        source: r.profile?.name,
      })),
    };
  }
}

function buildQuery(req: SearchRequest): string {
  let q = req.query;
  for (const d of req.includeDomains ?? []) q += ` site:${d}`;
  for (const d of req.excludeDomains ?? []) q += ` -site:${d}`;
  return q;
}

function mapFreshness(range?: SearchRequest['timeRange']): string | undefined {
  switch (range) {
    case 'day':
      return 'pd';
    case 'week':
      return 'pw';
    case 'month':
      return 'pm';
    case 'year':
      return 'py';
    default:
      return undefined;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
