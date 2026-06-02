/**
 * Test fakes for the Web_Scraper and Browser_Automation (Req 14.1-14.7).
 *
 * Each injectable port has a small, deterministic in-memory implementation so
 * the scraper's orchestration — robots evaluation, rate limiting, fetch-vs-
 * render escalation, extraction, and error handling — and the automation
 * runner can be unit-tested without a real network or browser:
 *
 *  - {@link FakePageFetcher} returns seeded {@link FetchedHtml} per URL, can be
 *    told to return an error status, and can be flagged to throw a network
 *    failure (Req 14.1).
 *  - {@link FakeBrowserEngine} returns seeded rendered HTML/screenshots and runs
 *    action lists deterministically, recording every call (Req 14.2, 14.4, 14.7).
 *  - {@link FakeRobotsFetcher} serves a seeded `robots.txt` body per origin, or
 *    `null` for "none published" (Req 14.5).
 *  - {@link RecordingRateLimiter} records each acquired domain without delay,
 *    and {@link ManualClock}/{@link RecordingWaiter} drive the real
 *    {@link IntervalRateLimiter} deterministically (Req 14.6).
 *
 * SECURITY note carried into tests: the seeded HTML is treated exactly as a real
 * untrusted page would be — parsed as data, never executed.
 */

import type {
  BrowseAction,
  BrowseActionResult,
  BrowseResult,
  BrowserEngine,
  BrowserRenderOptions,
  BrowserRenderResult,
  Clock,
  FetchOptions,
  FetchedHtml,
  PageFetcher,
  RateLimiter,
  RobotsFetcher,
  ScreenshotImage,
  Waiter,
} from './types.js';

/** A 1×1 transparent PNG, used as a deterministic fake screenshot. */
export const FAKE_SCREENSHOT: ScreenshotImage = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  width: 1,
  height: 1,
};

/** A seeded plain-fetch response for the {@link FakePageFetcher}. */
export interface SeededPage {
  /** The HTML body to return (defaults to a small valid document). */
  html?: string;
  /** The HTTP status (defaults to 200). */
  status?: number;
  /** The final URL after redirects (defaults to the requested URL). */
  finalUrl?: string;
  /** When set, `fetch` throws an `Error` with this message (a network failure). */
  networkError?: string;
}

/**
 * A {@link PageFetcher} fake returning seeded HTML per URL (Req 14.1).
 *
 * Seed a URL with {@link seed}; an unseeded URL returns a minimal 200 document.
 * Flag a URL with a `status` for an error response, or a `networkError` to
 * exercise the unreachable-page path.
 */
export class FakePageFetcher implements PageFetcher {
  /** Every `(url, options)` pair passed to {@link fetch}, in order. */
  readonly calls: Array<{ url: string; options?: FetchOptions }> = [];
  private readonly pages = new Map<string, SeededPage>();

  constructor(seed: Record<string, SeededPage> = {}) {
    for (const [url, page] of Object.entries(seed)) {
      this.pages.set(url, page);
    }
  }

  /** Seed (or replace) the response for a URL. */
  seed(url: string, page: SeededPage): this {
    this.pages.set(url, page);
    return this;
  }

  async fetch(url: string, options?: FetchOptions): Promise<FetchedHtml> {
    this.calls.push(options === undefined ? { url } : { url, options });
    const page = this.pages.get(url);
    if (page?.networkError !== undefined) {
      throw new Error(page.networkError);
    }
    return {
      url: page?.finalUrl ?? url,
      status: page?.status ?? 200,
      html: page?.html ?? '<html><head><title>Untitled</title></head><body><p>empty</p></body></html>',
      contentType: 'text/html',
    };
  }
}

/** A seeded render result for the {@link FakeBrowserEngine}. */
export interface SeededRender {
  /** The rendered HTML to return. */
  html?: string;
  /** The final URL after navigation (defaults to the requested URL). */
  finalUrl?: string;
  /** When set, `render` throws an `Error` with this message. */
  renderError?: string;
}

/**
 * A {@link BrowserEngine} fake (Req 14.2, 14.4, 14.7).
 *
 * `render` returns seeded post-JS HTML (and a {@link FAKE_SCREENSHOT} when a
 * screenshot is requested); `run` executes an action list deterministically,
 * returning a text value for each `extract`/`type`/`click` and a screenshot for
 * each `screenshot` action. Every call is recorded for assertions.
 */
export class FakeBrowserEngine implements BrowserEngine {
  /** Every `(url, options)` pair passed to {@link render}, in order. */
  readonly renderCalls: Array<{ url: string; options?: BrowserRenderOptions }> = [];
  /** Every `(url, actions)` pair passed to {@link run}, in order. */
  readonly runCalls: Array<{ url: string; actions: readonly BrowseAction[] }> = [];
  private readonly renders = new Map<string, SeededRender>();

  constructor(seed: Record<string, SeededRender> = {}) {
    for (const [url, render] of Object.entries(seed)) {
      this.renders.set(url, render);
    }
  }

  /** Seed (or replace) the render result for a URL. */
  seedRender(url: string, render: SeededRender): this {
    this.renders.set(url, render);
    return this;
  }

  async render(url: string, options?: BrowserRenderOptions): Promise<BrowserRenderResult> {
    this.renderCalls.push(options === undefined ? { url } : { url, options });
    const seeded = this.renders.get(url);
    if (seeded?.renderError !== undefined) {
      throw new Error(seeded.renderError);
    }
    const result: BrowserRenderResult = {
      url: seeded?.finalUrl ?? url,
      html:
        seeded?.html ??
        '<html><head><title>Rendered</title></head><body><main><p>rendered content</p></main></body></html>',
    };
    if (options?.screenshot === true) {
      result.screenshot = FAKE_SCREENSHOT;
    }
    return result;
  }

  async run(url: string, actions: readonly BrowseAction[]): Promise<BrowseResult> {
    this.runCalls.push({ url, actions });
    const seeded = this.renders.get(url);
    if (seeded?.renderError !== undefined) {
      throw new Error(seeded.renderError);
    }
    const screenshots: ScreenshotImage[] = [];
    const results: BrowseActionResult[] = actions.map((action) => {
      const result: BrowseActionResult = { type: action.type };
      if (action.selector !== undefined) {
        result.selector = action.selector;
      }
      if (action.type === 'screenshot') {
        result.screenshot = FAKE_SCREENSHOT;
        screenshots.push(FAKE_SCREENSHOT);
      } else if (action.type === 'extract') {
        result.value = `extracted:${action.selector ?? 'body'}`;
      } else if (action.type === 'type') {
        result.value = action.text ?? '';
      }
      return result;
    });
    return {
      url: seeded?.finalUrl ?? url,
      actions: results,
      finalHtml: seeded?.html ?? '<html><body><p>after actions</p></body></html>',
      screenshots,
    };
  }
}

/**
 * A {@link RobotsFetcher} fake serving a seeded `robots.txt` body per origin
 * (Req 14.5).
 *
 * An unseeded origin returns `null` ("none published" → everything allowed).
 */
export class FakeRobotsFetcher implements RobotsFetcher {
  /** Every origin passed to {@link fetchRobots}, in order. */
  readonly calls: string[] = [];
  private readonly bodies = new Map<string, string | null>();

  constructor(seed: Record<string, string | null> = {}) {
    for (const [origin, body] of Object.entries(seed)) {
      this.bodies.set(origin, body);
    }
  }

  /** Seed (or replace) the `robots.txt` body for an origin. */
  seed(origin: string, body: string | null): this {
    this.bodies.set(origin, body);
    return this;
  }

  async fetchRobots(origin: string): Promise<string | null> {
    this.calls.push(origin);
    return this.bodies.has(origin) ? (this.bodies.get(origin) ?? null) : null;
  }
}

/**
 * A {@link RateLimiter} fake that records each acquired domain and never delays
 * (Req 14.6).
 *
 * Lets a scraper test assert the limiter was consulted with the right domain
 * without slowing the test.
 */
export class RecordingRateLimiter implements RateLimiter {
  /** Every domain passed to {@link acquire}, in order. */
  readonly acquired: string[] = [];

  async acquire(domain: string): Promise<void> {
    this.acquired.push(domain);
  }
}

/**
 * A deterministic {@link Clock} whose time only advances when {@link advance}
 * is called (or when a {@link RecordingWaiter} bound to it waits).
 */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += Math.max(0, ms);
  }

  /** Set the clock to an absolute time. */
  set(ms: number): void {
    this.current = ms;
  }
}

/**
 * A {@link Waiter} fake that records each requested delay and advances a bound
 * {@link ManualClock} instead of sleeping, so the real
 * {@link import('./rate-limit.js').IntervalRateLimiter} can be tested instantly
 * yet deterministically (Req 14.6).
 */
export class RecordingWaiter implements Waiter {
  /** Every delay (ms) passed to {@link wait}, in order. */
  readonly waits: number[] = [];

  constructor(private readonly clock?: ManualClock) {}

  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
    this.clock?.advance(ms);
  }
}

/**
 * Build a small, valid HTML document with a main-content region and the usual
 * navigation/advertisement boilerplate around it, for extraction tests.
 *
 * @param options The pieces to include (title, main paragraphs, nav/ad markup).
 */
export function buildHtmlPage(options: {
  title?: string;
  description?: string;
  main?: string;
  withBoilerplate?: boolean;
} = {}): string {
  const title = options.title ?? 'Sample Article';
  const description = options.description ?? 'A sample page for scraper tests.';
  const main = options.main ?? '<p>This is the real article body with enough text to matter.</p>';
  const boilerplate =
    options.withBoilerplate === false
      ? ''
      : `<nav><a href="/home">Home</a><a href="/about">About</a></nav>
         <div class="ad-banner"><a href="https://ads.example/x">Buy now</a></div>
         <aside class="sidebar">Related links</aside>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta property="og:site_name" content="Example Site" />
    <script>window.__data = 1;</script>
    <style>.x{color:red}</style>
  </head>
  <body>
    <header>Site header</header>
    ${boilerplate}
    <main>${main}</main>
    <footer>Site footer</footer>
  </body>
</html>`;
}
