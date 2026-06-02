import { BraveProvider } from './providers/brave.provider';
import { ExaProvider } from './providers/exa.provider';
import { FirecrawlProvider } from './providers/firecrawl.provider';
import { SerperProvider } from './providers/serper.provider';
import { TavilyProvider } from './providers/tavily.provider';
import {
  ProviderRateLimitError,
  ProviderRequestError,
  ScrapeRequest,
  ScrapeResponse,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from './providers/types';
import { WebSearchApiProvider } from './providers/websearchapi.provider';

interface ProviderState {
  provider: SearchProvider;
  /** Epoch ms until which the provider is in cooldown (rate-limited). */
  cooldownUntil: number;
  /** Rolling failure count; used to temporarily deprioritize a flaky provider. */
  failures: number;
}

export interface RotationOptions {
  /**
   * Order in which providers are preferred. Rotation starts at a moving
   * cursor so load spreads evenly across the free tiers.
   */
  order?: string[];
}

/**
 * ProviderRotationService implements the rotate-to-spread-free-tier logic:
 *
 *  - Holds every configured provider (only those with an API key are active).
 *  - For each request it starts at a round-robin cursor and walks the ring,
 *    skipping providers that are in cooldown or don't support the operation.
 *  - On a rate-limit error it puts that provider on cooldown and moves on.
 *  - On any other error it counts a failure and falls through to the next.
 *  - The cursor advances every call so back-to-back requests hit different
 *    providers (request 1 -> provider A, request 2 -> provider B, ...).
 */
export class ProviderRotationService {
  private readonly states: ProviderState[];
  private cursor = 0;

  constructor(providers?: SearchProvider[], options: RotationOptions = {}) {
    const all = providers ?? [
      new SerperProvider(),
      new BraveProvider(),
      new WebSearchApiProvider(),
      new FirecrawlProvider(),
      new ExaProvider(),
      new TavilyProvider(),
    ];

    const active = all.filter((p) => p.isConfigured());
    const ordered = this.applyOrder(active, options.order);

    this.states = ordered.map((provider) => ({
      provider,
      cooldownUntil: 0,
      failures: 0,
    }));
  }

  /** Names of providers that are configured and currently usable. */
  get activeProviders(): string[] {
    return this.states.map((s) => s.provider.name);
  }

  hasAny(): boolean {
    return this.states.length > 0;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.run(
      'search',
      req as SearchRequest,
      (p) => Boolean(p.search),
      (p) => this.matchesSearchType(p, req),
    );
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeResponse> {
    return this.run('scrape', req, (p) => Boolean(p.scrape));
  }

  // --- internals -----------------------------------------------------------

  private async run<TReq, TRes>(
    op: 'search' | 'scrape',
    req: TReq,
    supports: (p: SearchProvider) => boolean,
    extraFilter: (p: SearchProvider) => boolean = () => true,
  ): Promise<TRes> {
    if (!this.hasAny()) {
      throw new Error(
        'No web search providers configured. Set at least one provider API key ' +
          '(SERPER_API_KEY, BRAVE_SEARCH_API_KEY, WEBSEARCHAPI_AI_KEY, ' +
          'FIRECRAWL_API_KEY, EXA_API_KEY, TAVILY_API_KEY).',
      );
    }

    const now = Date.now();
    const n = this.states.length;
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % n; // advance for the next call

    const errors: string[] = [];

    for (let i = 0; i < n; i++) {
      const state = this.states[(start + i) % n];
      if (!state) continue;
      const p = state.provider;

      if (state.cooldownUntil > now) continue;
      if (!supports(p) || !extraFilter(p)) continue;

      try {
        const result =
          op === 'search'
            ? await p.search!(req as unknown as SearchRequest)
            : await p.scrape!(req as unknown as ScrapeRequest);
        state.failures = 0;
        return result as unknown as TRes;
      } catch (err) {
        if (err instanceof ProviderRateLimitError) {
          state.cooldownUntil = Date.now() + err.retryAfterSeconds * 1000;
          errors.push(`${p.name}: rate-limited (cooldown ${err.retryAfterSeconds}s)`);
        } else if (err instanceof ProviderRequestError) {
          state.failures += 1;
          errors.push(`${p.name}: ${err.message}`);
        } else {
          state.failures += 1;
          errors.push(`${p.name}: ${(err as Error).message}`);
        }
        // fall through to the next provider
      }
    }

    throw new Error(
      `All web ${op} providers failed or are in cooldown. Attempts: ${errors.join(' | ')}`,
    );
  }

  private matchesSearchType(p: SearchProvider, req: SearchRequest): boolean {
    const type = req.searchType ?? 'general';
    return p.capabilities.searchTypes.includes(type);
  }

  private applyOrder(providers: SearchProvider[], order?: string[]): SearchProvider[] {
    if (!order || order.length === 0) return providers;
    const rank = new Map(order.map((name, idx) => [name, idx]));
    return [...providers].sort(
      (a, b) =>
        (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
    );
  }
}
