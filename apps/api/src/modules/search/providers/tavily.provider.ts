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
 * Tavily — search API tuned for LLM/RAG pipelines.
 * Search:  https://api.tavily.com/search
 * Extract: https://api.tavily.com/extract
 * Auth: api_key in the JSON body. Free tier: monthly credit allowance.
 */
export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  readonly capabilities = {
    search: true,
    scrape: true,
    searchTypes: ['general', 'news'] as const,
  };

  constructor(private readonly apiKey = process.env.TAVILY_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query: req.query,
      max_results: req.maxResults ?? 10,
      topic: req.searchType === 'news' ? 'news' : 'general',
    };
    if (req.includeDomains?.length) body.include_domains = req.includeDomains;
    if (req.excludeDomains?.length) body.exclude_domains = req.excludeDomains;

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'tavily 429', 60);
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
        snippet: r.content ?? '',
        publishedDate: r.published_date ?? null,
        score: r.score,
      })),
    };
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeResponse> {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey, urls: [req.url] }),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name, 'tavily extract 429', 60);
    }
    if (!res.ok) {
      throw new ProviderRequestError(this.name, await safeText(res), res.status);
    }

    const data: any = await res.json();
    const first = (data.results ?? [])[0] ?? {};
    return {
      provider: this.name,
      url: req.url,
      content: first.raw_content ?? first.content ?? '',
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
