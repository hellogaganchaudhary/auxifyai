/**
 * Web_Scraper and Browser_Automation (Req 14.1-14.7).
 *
 * This module turns a single URL into clean, model-ready content and drives
 * interactive browser sessions, entirely behind narrow injectable ports so it
 * is fully unit-testable without a real network or browser.
 *
 * The {@link WebScraper} ({@link WebScraper.scrape}) runs the full per-page
 * pipeline:
 *
 *   - validates the URL is an absolute `http(s)` URL ({@link InvalidUrlError});
 *   - evaluates the domain's `robots.txt` through the injectable
 *     {@link RobotsFetcher} and skips a disallowed path
 *     ({@link RobotsDisallowedError}, Req 14.5) using the pure
 *     {@link parseRobots}/{@link isPathAllowed} helpers;
 *   - enforces the configured per-domain rate limit through the injectable
 *     {@link RateLimiter} before any request (Req 14.6), with the default
 *     {@link IntervalRateLimiter} spacing same-host requests via an injected
 *     {@link Clock}/{@link Waiter};
 *   - obtains the page HTML either by a plain fetch through the injectable
 *     {@link PageFetcher} or — when the request enables JavaScript rendering or
 *     asks for a screenshot, or when a plain fetch returns a thin/empty body —
 *     by a headless-browser render through the injectable {@link BrowserEngine}
 *     (Req 14.2, 14.4); the fetch-vs-render choice is the pure, independently
 *     testable {@link decideRenderMode};
 *   - extracts content per the requested {@link ExtractionMode} — `full_text`,
 *     `main_content` (navigation/advertisement boilerplate stripped to
 *     Markdown, Req 14.1), `tables`, `links`, or `metadata` (Req 14.3) — and
 *     attaches a screenshot when requested (Req 14.4).
 *
 * The {@link BrowserAutomation} ({@link BrowserAutomation.run}) executes an
 * ordered list of click/type/scroll/screenshot/extract {@link BrowseAction}s
 * against a page through the same {@link BrowserEngine} port (Req 14.7).
 *
 * Caching a successful scrape for the configured retention period (Req 14.8) is
 * the Cache_Manager's responsibility (task 13.4) and composes this module's
 * {@link ScrapedContent} result.
 *
 * SECURITY: fetched HTML/text is *untrusted external content* — it is parsed as
 * data only and never executed; only the injected {@link BrowserEngine} runs
 * page scripts, and it is the production adapter's job to sandbox it. No port
 * carries platform secrets; a configured user agent is the only outbound
 * identity. Typed errors ({@link ScrapeFetchError}, {@link RobotsDisallowedError},
 * {@link BrowserAutomationError}, {@link InvalidUrlError}) each project into the
 * platform-wide {@link import('@auxify/types').PlatformError} shape (Req 46.8).
 */

export {
  WebScraper,
  decideRenderMode,
  DEFAULT_SCRAPER_USER_AGENT,
  THIN_CONTENT_THRESHOLD,
  type WebScraperOptions,
  type RenderMode,
  type RenderDecisionInput,
} from './web-scraper.js';

export { BrowserAutomation, type BrowserAutomationOptions } from './browser-automation.js';

export {
  IntervalRateLimiter,
  NoopRateLimiter,
  type IntervalRateLimiterOptions,
} from './rate-limit.js';

export {
  parseRobots,
  isPathAllowed,
  matchingRule,
  type RobotsRules,
} from './robots.js';

export { parseScrapeUrl, resolveUrl, type ParsedUrl } from './url.js';

export {
  decodeEntities,
  extractLinks,
  extractMetadata,
  extractTables,
  htmlToMarkdown,
  htmlToText,
  linksToMarkdown,
  metadataToMarkdown,
  normalizeWhitespace,
  selectMainContent,
  stripNonContent,
  tablesToMarkdown,
} from './extraction.js';

export {
  ScrapeFetchError,
  RobotsDisallowedError,
  BrowserAutomationError,
  InvalidUrlError,
  SCRAPE_FETCH_FAILED_CODE,
  ROBOTS_DISALLOWED_CODE,
  BROWSER_AUTOMATION_FAILED_CODE,
  INVALID_URL_CODE,
} from './errors.js';

export {
  EXTRACTION_MODES,
  DEFAULT_EXTRACTION_MODE,
  BROWSE_ACTION_TYPES,
  systemClock,
  systemWaiter,
  type ExtractionMode,
  type ScrapeRequest,
  type ScrapedContent,
  type PageMetadata,
  type ExtractedTable,
  type ExtractedLink,
  type ScreenshotImage,
  type FetchedHtml,
  type FetchOptions,
  type PageFetcher,
  type BrowseActionType,
  type BrowseAction,
  type BrowseActionResult,
  type BrowseResult,
  type BrowserRenderOptions,
  type BrowserRenderResult,
  type BrowserEngine,
  type RobotsFetcher,
  type Clock,
  type Waiter,
  type RateLimiter,
} from './types.js';
