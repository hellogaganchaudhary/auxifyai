import {
  ProviderRateLimitError,
  ProviderRequestError,
  ScrapeRequest,
  ScrapeResponse,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from './types';

/**
 * Exa.ai — neural/semantic search with content retrieval.
 * Search:   https://api.exa.ai/search
 * Contents: https://api.exa.ai/contents
 * Auth: x-api-key header. Free tier: monthly credit allowance.
 */
export class ExaProvider implements SearchProvider {
  readonly name = 'exa';
  readonly capabilities = {
    search: true,
    scrape: true,
    searchTypes: ['general', 'news', 'academic', 'code'] as const,
  };

  constructor(private readonly apiKey = process.env.EXA_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      query: req.query,
      numResults: req.maxResults ?? 10,
      type: 'auto',
      contents: { text: { maxCharacters: 1000 } },
    };
    if (req.includeDomains?.length) body.includeDomains = req.includeDomains;
    if (req.excludeDomains?.length) body.excludeDomains = req.excludeDomains;
    const startDate = mapStartDate(req.timeRange);
    if (startDate) body.startPublishedDate = startDate;
    if (req.searchType === 'news') body.category = 'news';

    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'exa 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const raw: any[] = data.results ?? [];
    return {
      provider: this.name,
      query: req.query,
      results: raw.slice(0, req.maxResults ?? 10).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.text ?? '').slice(0, 500),
        publishedDate: r.publishedDate ?? null,
        score: r.score,
      })),
    };
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeResponse> {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls: [req.url], text: true }),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'exa contents 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const first = (data.results ?? [])[0] ?? {};
    return {
      provider: this.name,
      url: req.url,
      content: first.text ?? '',
      title: first.title,
    };
  }
}

function mapStartDate(range?: SearchRequest['timeRange']): string | undefined {
  if (!range || range === 'all') return undefined;
  const now = Date.now();
  const day = 86_400_000;
  const deltas: Record<string, number> = {
    day: day,
    week: 7 * day,
    month: 30 * day,
    year: 365 * day,
  };
  const delta = deltas[range];
  return delta ? new Date(now - delta).toISOString() : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
