/**
 * Shared types for the web search & scraping provider abstraction.
 *
 * The platform integrates multiple third-party providers behind one interface
 * so the Model_Router / Web_Search_Engine never depends on a single vendor.
 * A rotation layer (see provider-rotation.service.ts) cycles requests across
 * providers to spread free-tier quota and to fail over on errors/limits.
 */

export type SearchType = 'general' | 'news' | 'academic' | 'code' | 'images';

export interface SearchRequest {
  query: string;
  searchType?: SearchType;
  timeRange?: 'day' | 'week' | 'month' | 'year' | 'all';
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string | null;
  source?: string;
  score?: number;
}

export interface SearchResponse {
  provider: string;
  query: string;
  results: SearchResultItem[];
  /** Provider-reported total, when available. */
  totalResults?: number;
}

export interface ScrapeRequest {
  url: string;
  /** What to pull out of the page. */
  extract?: 'full_text' | 'main_content' | 'tables' | 'links' | 'metadata';
  renderJs?: boolean;
  screenshot?: boolean;
}

export interface ScrapeResponse {
  provider: string;
  url: string;
  /** Cleaned, model-ready content (usually Markdown). */
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/** Capabilities a provider declares so the router can pick a compatible one. */
export interface ProviderCapabilities {
  search: boolean;
  scrape: boolean;
  /** Search types this provider can actually serve. */
  searchTypes: readonly SearchType[];
}

/**
 * Every concrete provider (Serper, Brave, WebSearchAPI.ai, Firecrawl, Exa,
 * Tavily) implements this interface.
 */
export interface SearchProvider {
  /** Stable identifier, e.g. "serper", "brave", "tavily". */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** True only when the provider has a configured API key. */
  isConfigured(): boolean;

  search?(req: SearchRequest): Promise<SearchResponse>;
  scrape?(req: ScrapeRequest): Promise<ScrapeResponse>;
}

/** Raised when a provider hits its rate/quota limit; signals the rotation
 *  layer to skip this provider until its cooldown elapses. */
export class ProviderRateLimitError extends Error {
  constructor(
    public readonly provider: string,
    message = 'rate limit exceeded',
    /** Seconds to wait before retrying this provider. */
    public readonly retryAfterSeconds = 60,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderRateLimitError';
  }
}

/** Generic provider failure (network, 5xx, bad payload). */
export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderRequestError';
  }
}
