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
 * Firecrawl.dev — scraping-first, with a search endpoint that also returns
 * scraped content. Best used as the primary SCRAPE provider.
 * Scrape: https://api.firecrawl.dev/v1/scrape
 * Search: https://api.firecrawl.dev/v1/search
 * Auth: Bearer token. Free tier: one-time credit pool.
 */
export class FirecrawlProvider implements SearchProvider {
  readonly name = 'firecrawl';
  readonly capabilities = {
    search: true,
    scrape: true,
    searchTypes: ['general'] as const,
  };

  constructor(private readonly apiKey = process.env.FIRECRAWL_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const res = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: req.query,
        limit: req.maxResults ?? 10,
      }),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'firecrawl search 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const raw: any[] = data.data ?? [];
    return {
      provider: this.name,
      query: req.query,
      results: raw.slice(0, req.maxResults ?? 10).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
        publishedDate: null,
      })),
    };
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeResponse> {
    const formats = req.screenshot ? ['markdown', 'screenshot'] : ['markdown'];
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: req.url,
        formats,
        // Firecrawl renders JS by default; expose the flag for parity.
        waitFor: req.renderJs ? 2000 : 0,
      }),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'firecrawl scrape 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const doc = data.data ?? {};
    return {
      provider: this.name,
      url: req.url,
      content: doc.markdown ?? '',
      title: doc.metadata?.title,
      metadata: doc.metadata,
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
