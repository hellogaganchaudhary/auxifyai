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
 * Serper.dev — Google SERP API.
 * Search: https://google.serper.dev/search (also /news)
 * Scrape: https://scrape.serper.dev
 * Auth: X-API-KEY header. Free tier grants a one-time credit pool.
 */
export class SerperProvider implements SearchProvider {
  readonly name = 'serper';
  readonly capabilities = {
    search: true,
    scrape: true,
    searchTypes: ['general', 'news', 'images'] as const,
  };

  constructor(private readonly apiKey = process.env.SERPER_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const endpoint =
      req.searchType === 'news'
        ? 'https://google.serper.dev/news'
        : req.searchType === 'images'
          ? 'https://google.serper.dev/images'
          : 'https://google.serper.dev/search';

    const tbs = mapTimeRange(req.timeRange);
    const body: Record<string, unknown> = {
      q: buildQuery(req),
      num: req.maxResults ?? 10,
    };
    if (tbs) body.tbs = tbs;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'serper 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const raw: any[] = data.organic ?? data.news ?? data.images ?? [];
    return {
      provider: this.name,
      query: req.query,
      results: raw.slice(0, req.maxResults ?? 10).map((r) => ({
        title: r.title ?? '',
        url: r.link ?? r.imageUrl ?? '',
        snippet: r.snippet ?? r.description ?? '',
        publishedDate: r.date ?? null,
        source: r.source,
        score: r.position ? 1 / r.position : undefined,
      })),
    };
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeResponse> {
    const res = await fetch('https://scrape.serper.dev', {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: req.url }),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'serper scrape 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    return {
      provider: this.name,
      url: req.url,
      content: data.markdown ?? data.text ?? '',
      title: data.metadata?.title,
      metadata: data.metadata,
    };
  }
}

function buildQuery(req: SearchRequest): string {
  let q = req.query;
  for (const d of req.includeDomains ?? []) q += ` site:${d}`;
  for (const d of req.excludeDomains ?? []) q += ` -site:${d}`;
  return q;
}

function mapTimeRange(range?: SearchRequest['timeRange']): string | undefined {
  switch (range) {
    case 'day':
      return 'qdr:d';
    case 'week':
      return 'qdr:w';
    case 'month':
      return 'qdr:m';
    case 'year':
      return 'qdr:y';
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
