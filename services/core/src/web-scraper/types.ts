/**
 * Domain records and injectable ports for the Web_Scraper and
 * Browser_Automation (Req 14.1-14.7).
 *
 * The Web_Scraper turns a single URL into clean, model-ready content: it
 * fetches the page, strips navigation/advertisement boilerplate, and returns
 * the main content as structured Markdown (Req 14.1) under one of several
 * extraction modes (Req 14.3). Pages that require JavaScript are rendered with
 * a headless browser first (Req 14.2), an optional screenshot is captured
 * (Req 14.4), the domain's `robots.txt` is honoured (Req 14.5), and a
 * per-domain rate limit is enforced (Req 14.6). Browser_Automation runs an
 * ordered list of click/type/scroll/screenshot/extract actions against a page
 * (Req 14.7).
 *
 * Every external capability the scraper cannot perform purely — fetching bytes
 * over the network ({@link PageFetcher}), rendering/driving a headless browser
 * ({@link BrowserEngine}), reading a domain's `robots.txt`
 * ({@link RobotsFetcher}), reading wall-clock time ({@link Clock}), and
 * sleeping for the rate limiter ({@link Waiter}) — is modelled here as a narrow
 * injectable port so the scraper is fully unit-testable with the fakes in
 * `./fakes.js`, without a real network or browser.
 *
 * SECURITY: fetched HTML/text is *untrusted external content*. It is parsed as
 * data only (see `./extraction.js`) and is never executed; the headless-browser
 * port is the sole component that runs page scripts, and it is injected so it
 * can be sandboxed by the production adapter. No port carries or transmits
 * platform secrets; a configured `userAgent` is the only outbound identity.
 *
 * The {@link PageFetcher} here is intentionally distinct from the
 * Input_Processor's `UrlFetcher` (Req 7.5): that port returns an
 * already-extracted preview ({@link import('../input/index.js')}), whereas the
 * scraper needs the *raw* HTML so it can perform its own boilerplate stripping
 * and Markdown conversion.
 */

/**
 * The content-extraction modes the Web_Scraper supports (Req 14.3).
 *
 *  - `full_text` — the page's readable text as Markdown, with only the
 *    hard-boilerplate (`<script>`/`<style>`) removed.
 *  - `main_content` — the primary article/main content as Markdown with
 *    navigation and advertisement boilerplate stripped (Req 14.1); the default.
 *  - `tables` — every data table on the page, as structured {@link ExtractedTable}s.
 *  - `links` — every hyperlink on the page, as {@link ExtractedLink}s.
 *  - `metadata` — the page's {@link PageMetadata} only (title, description, …).
 */
export type ExtractionMode = 'full_text' | 'main_content' | 'tables' | 'links' | 'metadata';

/** All {@link ExtractionMode} values, for iteration, validation, and tests. */
export const EXTRACTION_MODES: readonly ExtractionMode[] = [
  'full_text',
  'main_content',
  'tables',
  'links',
  'metadata',
] as const;

/** The default extraction mode when a request does not specify one (Req 14.1, 14.3). */
export const DEFAULT_EXTRACTION_MODE: ExtractionMode = 'main_content';

/**
 * A request to scrape a single URL (Req 14.1-14.4).
 *
 * `renderJs` opts into headless-browser rendering before extraction (Req 14.2);
 * `screenshot` requests a captured image of the page (Req 14.4); `extract`
 * selects the {@link ExtractionMode} (defaulting to `main_content`); `userAgent`
 * is the identity used for both the `robots.txt` evaluation (Req 14.5) and the
 * outbound fetch.
 */
export interface ScrapeRequest {
  /** The absolute URL to scrape. */
  url: string;
  /** Render the page with a headless browser before extracting (Req 14.2). */
  renderJs?: boolean;
  /** The extraction mode; defaults to {@link DEFAULT_EXTRACTION_MODE} (Req 14.3). */
  extract?: ExtractionMode;
  /** Capture and return a screenshot of the page (Req 14.4). */
  screenshot?: boolean;
  /** The user agent used for `robots.txt` evaluation and the fetch (Req 14.5). */
  userAgent?: string;
}

/**
 * Metadata extracted from a page's `<head>` and Open Graph tags (Req 14.3).
 *
 * Every field is optional; absent fields simply were not present on the page.
 */
export interface PageMetadata {
  /** The page title (`<title>` or `og:title`). */
  title?: string;
  /** The page description (`meta[name=description]` or `og:description`). */
  description?: string;
  /** The site name (`og:site_name`), when present. */
  siteName?: string;
  /** The author (`meta[name=author]`), when present. */
  author?: string;
  /** The published date (`article:published_time`), when present. */
  publishedDate?: string;
  /** A preview image URL (`og:image`), when present. */
  imageUrl?: string;
  /** The canonical URL (`link[rel=canonical]` or `og:url`), when present. */
  canonicalUrl?: string;
  /** The content language (`<html lang>`), when present. */
  language?: string;
}

/** A data table extracted from a page (Req 14.3, `tables` mode). */
export interface ExtractedTable {
  /** The header cells, in column order (empty when the table had no header row). */
  headers: string[];
  /** The body rows, each a list of cell texts in column order. */
  rows: string[][];
}

/** A hyperlink extracted from a page (Req 14.3, `links` mode). */
export interface ExtractedLink {
  /** The link's visible text. */
  text: string;
  /** The link's resolved (absolute when derivable) target URL. */
  href: string;
}

/**
 * A captured screenshot image (Req 14.4, 14.7).
 *
 * The bytes are carried base64-encoded so the result is JSON-serialisable
 * across the REST_API/WebSocket boundary.
 */
export interface ScreenshotImage {
  /** The image MIME type (e.g. `image/png`). */
  mimeType: string;
  /** The base64-encoded image bytes. */
  data: string;
  /** The image width in pixels, when known. */
  width?: number;
  /** The image height in pixels, when known. */
  height?: number;
}

/**
 * The normalized result of a successful scrape (Req 14.1-14.4).
 *
 * `content` is always the mode-specific primary output rendered as Markdown
 * (the boilerplate-stripped main content for `main_content`/`full_text`, a
 * Markdown table block for `tables`, a Markdown link list for `links`, and a
 * Markdown metadata block for `metadata`). `metadata` is always populated;
 * `tables`/`links` are populated only for their respective modes (otherwise
 * empty). `rendered` records whether a headless browser produced the HTML.
 */
export interface ScrapedContent {
  /** The original requested URL. */
  requestedUrl: string;
  /** The final URL the content was read from (after any redirect). */
  url: string;
  /** The extraction mode applied. */
  mode: ExtractionMode;
  /** The mode-specific primary output, as Markdown (Req 14.1). */
  content: string;
  /** The page metadata (always extracted). */
  metadata: PageMetadata;
  /** Extracted tables (populated for the `tables` mode; otherwise empty). */
  tables: ExtractedTable[];
  /** Extracted links (populated for the `links` mode; otherwise empty). */
  links: ExtractedLink[];
  /** The captured screenshot, when one was requested and produced (Req 14.4). */
  screenshot?: ScreenshotImage;
  /** Whether the HTML was produced by a headless browser render (Req 14.2). */
  rendered: boolean;
}

/** The raw HTML body of a fetched page, as returned by a {@link PageFetcher}. */
export interface FetchedHtml {
  /** The final URL after any redirects. */
  url: string;
  /** The HTTP status code of the response. */
  status: number;
  /** The raw, unparsed response body (treated as untrusted data). */
  html: string;
  /** The response `Content-Type`, when known. */
  contentType?: string;
}

/** Per-fetch options shared by the {@link PageFetcher} and {@link BrowserEngine}. */
export interface FetchOptions {
  /** The user agent to send with the request (Req 14.5). */
  userAgent?: string;
}

/**
 * The port that fetches raw page HTML over the network (Req 14.1).
 *
 * Modelling the plain fetch as a port keeps the Web_Scraper independent of any
 * concrete HTTP client and lets the unit tests inject deterministic responses
 * (including error statuses and network failures) without real I/O. The port
 * returns the *raw* HTML — boilerplate stripping and Markdown conversion are
 * the scraper's job, so the returned body is untrusted and never executed.
 */
export interface PageFetcher {
  /**
   * Fetch a URL and return its raw HTML body and status.
   *
   * @param url The absolute URL to fetch.
   * @param options Optional per-fetch settings (e.g. `userAgent`).
   * @returns The fetched HTML, status, and final URL.
   * @throws When the page is unreachable (network failure); the scraper wraps
   *   this into a typed {@link import('./errors.js').ScrapeFetchError}.
   */
  fetch(url: string, options?: FetchOptions): Promise<FetchedHtml>;
}

/** The interactive browser actions Browser_Automation can perform (Req 14.7). */
export type BrowseActionType = 'click' | 'type' | 'scroll' | 'screenshot' | 'extract';

/** All {@link BrowseActionType} values, in the requirement's order, for tests. */
export const BROWSE_ACTION_TYPES: readonly BrowseActionType[] = [
  'click',
  'type',
  'scroll',
  'screenshot',
  'extract',
] as const;

/**
 * A single ordered browser action (Req 14.7).
 *
 * The optional fields are interpreted per `type`: `selector` targets an element
 * for `click`/`type`/`extract`; `text` is the string to enter for `type`; `x`
 * and `y` are the scroll offsets for `scroll`.
 */
export interface BrowseAction {
  /** The kind of action to perform. */
  type: BrowseActionType;
  /** The CSS selector the action targets (`click`/`type`/`extract`). */
  selector?: string;
  /** The text to type (`type`). */
  text?: string;
  /** The horizontal scroll offset in pixels (`scroll`). */
  x?: number;
  /** The vertical scroll offset in pixels (`scroll`). */
  y?: number;
}

/** The result of executing one {@link BrowseAction} (Req 14.7). */
export interface BrowseActionResult {
  /** The action type that was executed. */
  type: BrowseActionType;
  /** The selector the action targeted, when applicable. */
  selector?: string;
  /** The extracted text for an `extract` action. */
  value?: string;
  /** The captured image for a `screenshot` action. */
  screenshot?: ScreenshotImage;
}

/** The outcome of a Browser_Automation run (Req 14.7). */
export interface BrowseResult {
  /** The URL the actions were run against. */
  url: string;
  /** Per-action results, in the same order as the requested actions. */
  actions: BrowseActionResult[];
  /** The page's HTML after the last action completed. */
  finalHtml: string;
  /** Every screenshot captured during the run, in capture order. */
  screenshots: ScreenshotImage[];
}

/** Options for a headless-browser render (Req 14.2, 14.4). */
export interface BrowserRenderOptions {
  /** The user agent the browser presents. */
  userAgent?: string;
  /** Capture a screenshot of the rendered page (Req 14.4). */
  screenshot?: boolean;
}

/** The result of rendering a page with a headless browser (Req 14.2). */
export interface BrowserRenderResult {
  /** The final URL after navigation. */
  url: string;
  /** The rendered DOM serialized to HTML (treated as untrusted data). */
  html: string;
  /** The captured screenshot, when requested (Req 14.4). */
  screenshot?: ScreenshotImage;
}

/**
 * The port that drives a headless browser (Req 14.2, 14.4, 14.7).
 *
 * Modelling the browser as a port keeps the Web_Scraper and Browser_Automation
 * independent of any concrete engine (e.g. Playwright) and lets the unit tests
 * inject a deterministic fake. `render` produces post-JavaScript HTML (and an
 * optional screenshot) for the scraper; `run` executes an ordered action list
 * for Browser_Automation. The production adapter is responsible for sandboxing
 * the real browser.
 */
export interface BrowserEngine {
  /**
   * Navigate to `url`, execute the page's scripts, and return the rendered
   * HTML plus an optional screenshot (Req 14.2, 14.4).
   *
   * @param url The URL to render.
   * @param options Render options (user agent, screenshot).
   */
  render(url: string, options?: BrowserRenderOptions): Promise<BrowserRenderResult>;

  /**
   * Navigate to `url` and execute `actions` in order, returning each action's
   * result, the final HTML, and any screenshots (Req 14.7).
   *
   * @param url The URL to drive.
   * @param actions The ordered actions to perform.
   */
  run(url: string, actions: readonly BrowseAction[]): Promise<BrowseResult>;
}

/**
 * The port that reads a domain's `robots.txt` (Req 14.5).
 *
 * Returning `null` models "no `robots.txt` published" (HTTP 404 or unreachable),
 * which is treated as "everything allowed" per the robots convention. The body
 * is parsed by the pure {@link import('./robots.js')} helpers, so this port only
 * has to retrieve the text.
 */
export interface RobotsFetcher {
  /**
   * Fetch the `robots.txt` body for an origin (scheme + host), or `null` when
   * none is published.
   *
   * @param origin The origin to read `robots.txt` from (e.g. `https://example.com`).
   */
  fetchRobots(origin: string): Promise<string | null>;
}

/**
 * A monotonic-enough wall clock, injectable so per-domain rate limiting
 * (Req 14.6) is deterministic in tests.
 *
 * Shares the same shape as the Model_Router's `Clock` (Req 3.9) but is declared
 * here to keep the module self-contained.
 */
export interface Clock {
  /** The current time in milliseconds (epoch or any consistent origin). */
  now(): number;
}

/** The default {@link Clock}, backed by the global `Date.now`. */
export const systemClock: Clock = { now: () => Date.now() };

/**
 * The port that waits for a duration, injectable so the rate limiter's delay
 * (Req 14.6) is deterministic and instant in tests.
 */
export interface Waiter {
  /**
   * Resolve after at least `ms` milliseconds have elapsed.
   *
   * @param ms The minimum delay in milliseconds (never negative).
   */
  wait(ms: number): Promise<void>;
}

/** The default {@link Waiter}, backed by `setTimeout`. */
export const systemWaiter: Waiter = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/**
 * The port that enforces the configured per-domain scrape rate limit (Req 14.6).
 *
 * The scraper calls {@link RateLimiter.acquire} with the target domain before
 * every fetch; the implementation resolves only once it is safe (per the
 * configured limit) to issue a request to that domain. Modelling it as a port
 * lets a test substitute a recording/no-op limiter while the default
 * {@link import('./rate-limit.js').IntervalRateLimiter} enforces a real minimum
 * interval using the injected {@link Clock}/{@link Waiter}.
 */
export interface RateLimiter {
  /**
   * Resolve once it is permissible to issue a request to `domain`.
   *
   * @param domain The host the next request targets (e.g. `example.com`).
   */
  acquire(domain: string): Promise<void>;
}
