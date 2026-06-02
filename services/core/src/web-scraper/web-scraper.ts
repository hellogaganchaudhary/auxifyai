/**
 * The Web_Scraper: fetch, clean, and extract a single page (Req 14.1-14.6).
 *
 * {@link WebScraper.scrape} orchestrates the full pipeline for one URL:
 *
 *  1. Validate the URL is an absolute `http(s)` URL ({@link InvalidUrlError}).
 *  2. Evaluate the domain's `robots.txt` and skip a disallowed path
 *     ({@link RobotsDisallowedError}, Req 14.5).
 *  3. Acquire the per-domain rate-limit slot before any request (Req 14.6).
 *  4. Obtain the page HTML, either by a plain fetch through the
 *     {@link PageFetcher} or — when JavaScript rendering is required — by a
 *     headless-browser render through the {@link BrowserEngine} (Req 14.2). The
 *     {@link decideRenderMode} helper encodes *when* a plain fetch is escalated
 *     to a render.
 *  5. Extract content per the requested {@link ExtractionMode}, stripping
 *     navigation/advertisement boilerplate and producing Markdown (Req 14.1,
 *     14.3), and attach a screenshot when requested (Req 14.4).
 *
 * Every external capability is an injectable port, so the scraper is fully
 * unit-testable with the fakes in `./fakes.js` and never touches a real network
 * or browser here. SECURITY: fetched HTML is untrusted and parsed as data only;
 * only the injected {@link BrowserEngine} ever executes page scripts.
 */

import {
  extractLinks,
  extractMetadata,
  extractTables,
  htmlToMarkdown,
  htmlToText,
  linksToMarkdown,
  metadataToMarkdown,
  selectMainContent,
  stripNonContent,
  tablesToMarkdown,
} from './extraction.js';
import {
  BrowserAutomationError,
  InvalidUrlError,
  RobotsDisallowedError,
  ScrapeFetchError,
} from './errors.js';
import { isPathAllowed, matchingRule, parseRobots } from './robots.js';
import { NoopRateLimiter } from './rate-limit.js';
import {
  DEFAULT_EXTRACTION_MODE,
  type BrowserEngine,
  type ExtractionMode,
  type PageFetcher,
  type RateLimiter,
  type RobotsFetcher,
  type ScrapeRequest,
  type ScrapedContent,
} from './types.js';
import { parseScrapeUrl } from './url.js';

/** The default user agent the scraper presents for `robots.txt` and fetches. */
export const DEFAULT_SCRAPER_USER_AGENT = 'AuxifyBot' as const;

/**
 * Below this many characters of extractable text, a plain-fetch body is treated
 * as "thin" — a strong sign the page renders its content with JavaScript — and
 * the scrape is escalated to a headless-browser render when an engine is
 * available (Req 14.2).
 */
export const THIN_CONTENT_THRESHOLD = 200;

/** Construction options for the {@link WebScraper}. */
export interface WebScraperOptions {
  /** The port that fetches raw page HTML (Req 14.1). */
  fetcher: PageFetcher;
  /** The port that reads `robots.txt` (Req 14.5). */
  robots: RobotsFetcher;
  /** The headless-browser engine for JS rendering/screenshots (Req 14.2, 14.4); optional. */
  browser?: BrowserEngine;
  /** The per-domain rate limiter (Req 14.6); defaults to a no-op limiter. */
  rateLimiter?: RateLimiter;
  /** The user agent presented for `robots.txt` and fetches; defaults to {@link DEFAULT_SCRAPER_USER_AGENT}. */
  userAgent?: string;
  /**
   * Automatically escalate a thin/empty plain-fetch result to a headless-browser
   * render when an engine is available (Req 14.2). Defaults to `true`.
   */
  autoEscalateToBrowser?: boolean;
}

/** How a page's HTML should be obtained, as decided by {@link decideRenderMode}. */
export type RenderMode = 'fetch' | 'render';

/**
 * The Web_Scraper component (Req 14.1-14.6).
 */
export class WebScraper {
  private readonly fetcher: PageFetcher;
  private readonly robots: RobotsFetcher;
  private readonly browser: BrowserEngine | undefined;
  private readonly rateLimiter: RateLimiter;
  private readonly userAgent: string;
  private readonly autoEscalate: boolean;

  constructor(options: WebScraperOptions) {
    this.fetcher = options.fetcher;
    this.robots = options.robots;
    this.browser = options.browser;
    this.rateLimiter = options.rateLimiter ?? new NoopRateLimiter();
    this.userAgent = options.userAgent ?? DEFAULT_SCRAPER_USER_AGENT;
    this.autoEscalate = options.autoEscalateToBrowser ?? true;
  }

  /**
   * Scrape a single URL and return its normalized, Markdown content (Req 14.1).
   *
   * @param req The scrape request (URL, render flag, extraction mode, screenshot).
   * @returns The extracted, normalized content.
   * @throws {@link InvalidUrlError} when the URL is not an absolute http(s) URL.
   * @throws {@link RobotsDisallowedError} when robots.txt disallows the path (Req 14.5).
   * @throws {@link ScrapeFetchError} when the page is unreachable/blocked (Req 14.1).
   * @throws {@link BrowserAutomationError} when a required render fails (Req 14.2).
   */
  async scrape(req: ScrapeRequest): Promise<ScrapedContent> {
    const parsed = parseScrapeUrl(req.url);
    if (parsed === null) {
      throw new InvalidUrlError(req.url);
    }
    const userAgent = req.userAgent ?? this.userAgent;

    // Req 14.5 — evaluate robots.txt before fetching, and skip disallowed paths.
    await this.assertRobotsAllows(parsed.origin, parsed.pathAndQuery, parsed.href, userAgent);

    // Req 14.6 — enforce the per-domain rate limit before any request.
    await this.rateLimiter.acquire(parsed.host);

    const mode: ExtractionMode = req.extract ?? DEFAULT_EXTRACTION_MODE;
    const wantsScreenshot = req.screenshot === true;

    // Decide how to obtain the HTML (plain fetch vs headless render, Req 14.2).
    const decision = decideRenderMode({
      renderJs: req.renderJs === true,
      screenshot: wantsScreenshot,
    });

    const page = await this.obtainHtml(parsed.href, decision, wantsScreenshot, userAgent);

    return this.extract(req.url, page.url, page.html, mode, page.rendered, page.screenshot);
  }

  /**
   * Evaluate `robots.txt` for `origin` and throw {@link RobotsDisallowedError}
   * when `path` is disallowed for `userAgent` (Req 14.5).
   */
  private async assertRobotsAllows(
    origin: string,
    path: string,
    href: string,
    userAgent: string,
  ): Promise<void> {
    const body = await this.robots.fetchRobots(origin);
    const rules = parseRobots(body, userAgent);
    if (!isPathAllowed(rules, path)) {
      const matched = matchingRule(rules, path);
      throw new RobotsDisallowedError(href, matched?.path ?? path);
    }
  }

  /** Obtain the page HTML per the render decision, plus an optional screenshot. */
  private async obtainHtml(
    href: string,
    decision: RenderMode,
    wantsScreenshot: boolean,
    userAgent: string,
  ): Promise<{ url: string; html: string; rendered: boolean; screenshot?: ScrapedContent['screenshot'] }> {
    if (decision === 'render') {
      return this.renderWithBrowser(href, wantsScreenshot, userAgent);
    }

    const fetched = await this.fetchPlain(href, userAgent);

    // Auto-escalate a thin/empty body to a render when an engine is available
    // and the page looks JS-driven (Req 14.2).
    if (
      this.autoEscalate &&
      this.browser !== undefined &&
      (wantsScreenshot || this.isThin(fetched.html))
    ) {
      return this.renderWithBrowser(href, wantsScreenshot, userAgent);
    }

    return { url: fetched.url, html: fetched.html, rendered: false };
  }

  /** Perform a plain fetch and convert a non-OK status / network failure to a typed error (Req 14.1). */
  private async fetchPlain(href: string, userAgent: string): Promise<{ url: string; html: string }> {
    let response;
    try {
      response = await this.fetcher.fetch(href, { userAgent });
    } catch (cause) {
      throw new ScrapeFetchError(href, undefined, safeReason(cause));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ScrapeFetchError(href, response.status);
    }
    return { url: response.url, html: response.html };
  }

  /** Render a page with the headless browser, mapping failures to a typed error (Req 14.2, 14.4). */
  private async renderWithBrowser(
    href: string,
    wantsScreenshot: boolean,
    userAgent: string,
  ): Promise<{ url: string; html: string; rendered: boolean; screenshot?: ScrapedContent['screenshot'] }> {
    if (this.browser === undefined) {
      // A render was required but no engine is configured: fail closed.
      throw new BrowserAutomationError(href, 'no headless browser engine is configured');
    }
    let result;
    try {
      result = await this.browser.render(href, { userAgent, screenshot: wantsScreenshot });
    } catch (cause) {
      throw new BrowserAutomationError(href, safeReason(cause));
    }
    return {
      url: result.url,
      html: result.html,
      rendered: true,
      ...(result.screenshot !== undefined ? { screenshot: result.screenshot } : {}),
    };
  }

  /** Whether a fetched body has too little extractable text to be the real content. */
  private isThin(html: string): boolean {
    const text = htmlToText(stripNonContent(html));
    return text.length < THIN_CONTENT_THRESHOLD;
  }

  /** Run the requested extraction mode over the obtained HTML (Req 14.1, 14.3, 14.4). */
  private extract(
    requestedUrl: string,
    finalUrl: string,
    rawHtml: string,
    mode: ExtractionMode,
    rendered: boolean,
    screenshot: ScrapedContent['screenshot'],
  ): ScrapedContent {
    const cleaned = stripNonContent(rawHtml);
    const metadata = extractMetadata(rawHtml);

    let content = '';
    let tables: ScrapedContent['tables'] = [];
    let links: ScrapedContent['links'] = [];

    switch (mode) {
      case 'full_text': {
        content = htmlToMarkdown(cleaned, finalUrl);
        break;
      }
      case 'main_content': {
        content = htmlToMarkdown(selectMainContent(cleaned), finalUrl);
        break;
      }
      case 'tables': {
        tables = extractTables(cleaned);
        content = tablesToMarkdown(tables);
        break;
      }
      case 'links': {
        links = extractLinks(cleaned, finalUrl);
        content = linksToMarkdown(links);
        break;
      }
      case 'metadata': {
        content = metadataToMarkdown(metadata);
        break;
      }
    }

    return {
      requestedUrl,
      url: finalUrl,
      mode,
      content,
      metadata,
      tables,
      links,
      rendered,
      ...(screenshot !== undefined ? { screenshot } : {}),
    };
  }
}

/** The inputs to the fetch-vs-render decision (Req 14.2, 14.4). */
export interface RenderDecisionInput {
  /** Whether the request explicitly enabled JavaScript rendering (Req 14.2). */
  renderJs: boolean;
  /** Whether the request asked for a screenshot (only a browser can capture one, Req 14.4). */
  screenshot: boolean;
}

/**
 * Decide whether the initial HTML should come from a plain fetch or a
 * headless-browser render (Req 14.2, 14.4).
 *
 * This is an *intent* decision based solely on the request flags: a render is
 * required when the caller explicitly enabled JavaScript rendering (Req 14.2)
 * or requested a screenshot (only a browser can capture one, Req 14.4);
 * otherwise a plain fetch suffices (and may still be escalated afterwards if it
 * returns a thin/empty body — see {@link WebScraper}). When a render is required
 * but no {@link BrowserEngine} is configured the scraper fails closed with a
 * {@link BrowserAutomationError}, honouring the requirement's SHALL rather than
 * silently downgrading. Keeping this a pure function makes the decision
 * independently unit-testable.
 *
 * @param input The decision inputs.
 * @returns `'render'` to use the headless browser first, else `'fetch'`.
 */
export function decideRenderMode(input: RenderDecisionInput): RenderMode {
  if (input.renderJs || input.screenshot) {
    return 'render';
  }
  return 'fetch';
}

/** Reduce an unknown thrown value to a safe, secret-free reason string (Req 34.7). */
function safeReason(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === 'string') {
    return cause.message;
  }
  return 'network error';
}
