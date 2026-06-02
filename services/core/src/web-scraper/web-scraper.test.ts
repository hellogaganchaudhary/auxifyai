/**
 * Unit tests for the Web_Scraper and Browser_Automation (Req 14.1-14.7).
 *
 * These exercise the orchestration against the in-memory fakes in `./fakes.js`
 * — no real network or browser — covering the task's required scenarios:
 *
 *  - plain fetch + boilerplate-stripped Markdown extraction (Req 14.1, 14.3);
 *  - escalation from a plain fetch to a headless-browser render, both when the
 *    request explicitly enables JS rendering and when a plain fetch returns a
 *    thin/empty body (Req 14.2), plus the pure {@link decideRenderMode};
 *  - error handling for an unreachable page (network failure) and a blocked
 *    page (non-OK HTTP status), and for a robots.txt-disallowed path (Req 14.5);
 *  - content normalization across the extraction modes (Req 14.3) and the
 *    per-domain rate-limit consultation (Req 14.6);
 *  - Browser_Automation running ordered actions (Req 14.7).
 */

import { describe, expect, it } from 'vitest';

import { BrowserAutomation } from './browser-automation.js';
import {
  BrowserAutomationError,
  InvalidUrlError,
  RobotsDisallowedError,
  ScrapeFetchError,
} from './errors.js';
import {
  buildHtmlPage,
  FakeBrowserEngine,
  FakePageFetcher,
  FakeRobotsFetcher,
  RecordingRateLimiter,
} from './fakes.js';
import {
  decideRenderMode,
  WebScraper,
  type WebScraperOptions,
} from './web-scraper.js';

const URL = 'https://example.com/articles/post';
const ORIGIN = 'https://example.com';

/** Build a scraper wired to fresh fakes, with optional overrides. */
function makeScraper(overrides: Partial<WebScraperOptions> = {}): {
  scraper: WebScraper;
  fetcher: FakePageFetcher;
  robots: FakeRobotsFetcher;
  browser: FakeBrowserEngine;
  rateLimiter: RecordingRateLimiter;
} {
  const fetcher = overrides.fetcher instanceof FakePageFetcher ? overrides.fetcher : new FakePageFetcher();
  const robots = overrides.robots instanceof FakeRobotsFetcher ? overrides.robots : new FakeRobotsFetcher();
  const browser =
    overrides.browser instanceof FakeBrowserEngine ? overrides.browser : new FakeBrowserEngine();
  const rateLimiter =
    overrides.rateLimiter instanceof RecordingRateLimiter
      ? overrides.rateLimiter
      : new RecordingRateLimiter();
  const scraper = new WebScraper({
    fetcher,
    robots,
    browser,
    rateLimiter,
    ...overrides,
  });
  return { scraper, fetcher, robots, browser, rateLimiter };
}

describe('WebScraper — plain fetch and extraction (Req 14.1, 14.3)', () => {
  it('fetches a page and returns boilerplate-stripped main content as Markdown', async () => {
    const html = buildHtmlPage({
      title: 'Hello World',
      main: '<h1>Hello World</h1><p>The quick brown fox jumps over the lazy dog. '.padEnd(260, 'x') + '</p>',
    });
    const fetcher = new FakePageFetcher({ [URL]: { html } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const result = await scraper.scrape({ url: URL });

    expect(result.rendered).toBe(false);
    expect(result.mode).toBe('main_content');
    expect(result.url).toBe(URL);
    // Main content present...
    expect(result.content).toContain('Hello World');
    // ...nav/ad/footer boilerplate stripped (Req 14.1).
    expect(result.content).not.toContain('Site footer');
    expect(result.content).not.toContain('Buy now');
    expect(result.content).not.toContain('About');
    // Metadata always extracted.
    expect(result.metadata.title).toBe('Hello World');
    expect(result.metadata.siteName).toBe('Example Site');
  });

  it('extracts metadata-only in metadata mode and never includes scripts/styles', async () => {
    const html = buildHtmlPage({ title: 'Meta Page', description: 'Desc here' });
    const fetcher = new FakePageFetcher({ [URL]: { html } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const result = await scraper.scrape({ url: URL, extract: 'metadata' });

    expect(result.mode).toBe('metadata');
    expect(result.metadata.title).toBe('Meta Page');
    expect(result.metadata.description).toBe('Desc here');
    // Untrusted script/style content never leaks into the output.
    expect(result.content).not.toContain('window.__data');
    expect(result.content).not.toContain('color:red');
  });

  it('extracts tables as a Markdown table block (Req 14.3)', async () => {
    const html = `<html><body><main><table>
      <tr><th>Name</th><th>Age</th></tr>
      <tr><td>Ada</td><td>36</td></tr>
      <tr><td>Alan</td><td>41</td></tr>
    </table></main></body></html>`;
    const fetcher = new FakePageFetcher({ [URL]: { html } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const result = await scraper.scrape({ url: URL, extract: 'tables' });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.headers).toEqual(['Name', 'Age']);
    expect(result.tables[0]?.rows).toEqual([
      ['Ada', '36'],
      ['Alan', '41'],
    ]);
    expect(result.content).toContain('| Name | Age |');
    expect(result.content).toContain('| Ada | 36 |');
  });

  it('extracts links with resolved absolute URLs (Req 14.3)', async () => {
    const html = `<html><body><main>
      <a href="/relative/path">Relative</a>
      <a href="https://other.example/abs">Absolute</a>
      <a href="#frag">Fragment skipped</a>
      <a href="javascript:alert(1)">Script skipped</a>
    </main></body></html>`;
    const fetcher = new FakePageFetcher({ [URL]: { html } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const result = await scraper.scrape({ url: URL, extract: 'links' });

    const hrefs = result.links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/relative/path');
    expect(hrefs).toContain('https://other.example/abs');
    // fragment-only and javascript: links are excluded.
    expect(hrefs.some((h) => h.includes('#frag'))).toBe(false);
    expect(hrefs.some((h) => h.toLowerCase().startsWith('javascript:'))).toBe(false);
  });

  it('normalizes whitespace in extracted content (Req 14.1, 14.3)', async () => {
    const html = `<html><body><main><p>Lots   of\n\n\n   whitespace\t\there.${'.'.repeat(220)}</p></main></body></html>`;
    const fetcher = new FakePageFetcher({ [URL]: { html } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const result = await scraper.scrape({ url: URL, extract: 'full_text' });

    expect(result.content).not.toMatch(/ {2,}/);
    expect(result.content).not.toMatch(/\n{3,}/);
    expect(result.content.startsWith(' ')).toBe(false);
    expect(result.content.endsWith(' ')).toBe(false);
  });

  it('consults the per-domain rate limiter with the host before fetching (Req 14.6)', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const rateLimiter = new RecordingRateLimiter();
    const { scraper } = makeScraper({ fetcher, rateLimiter, browser: undefined });

    await scraper.scrape({ url: URL });

    expect(rateLimiter.acquired).toEqual(['example.com']);
  });
});

describe('WebScraper — robots.txt evaluation (Req 14.5)', () => {
  it('skips a disallowed path with a RobotsDisallowedError and never fetches it', async () => {
    const robots = new FakeRobotsFetcher({
      [ORIGIN]: 'User-agent: *\nDisallow: /articles/',
    });
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const { scraper } = makeScraper({ fetcher, robots, browser: undefined });

    const error = await scraper.scrape({ url: URL }).then(
      () => {
        throw new Error('expected scrape to be disallowed by robots.txt');
      },
      (caught: unknown) => caught as RobotsDisallowedError,
    );

    expect(error).toBeInstanceOf(RobotsDisallowedError);
    expect(error.rule).toBe('/articles/');
    const platform = error.toPlatformError('corr-robots');
    expect(platform.category).toBe('authorization');
    expect(platform.code).toBe('ROBOTS_DISALLOWED');
    // The disallowed page was never fetched.
    expect(fetcher.calls).toHaveLength(0);
  });

  it('allows a path not covered by any Disallow rule', async () => {
    const robots = new FakeRobotsFetcher({
      [ORIGIN]: 'User-agent: *\nDisallow: /private/',
    });
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const { scraper } = makeScraper({ fetcher, robots, browser: undefined });

    const result = await scraper.scrape({ url: URL });
    expect(result.url).toBe(URL);
    expect(fetcher.calls).toHaveLength(1);
  });

  it('allows everything when no robots.txt is published', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const { scraper, robots } = makeScraper({ fetcher, browser: undefined });

    await scraper.scrape({ url: URL });
    // robots was consulted (returned null → allow all).
    expect(robots.calls).toEqual([ORIGIN]);
  });
});

describe('WebScraper — escalation to headless-browser rendering (Req 14.2, 14.4)', () => {
  it('renders with the browser when renderJs is enabled', async () => {
    const rendered = buildHtmlPage({ title: 'Rendered', main: '<p>JS produced this content.'.padEnd(260, '!') + '</p>' });
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const browser = new FakeBrowserEngine({ [URL]: { html: rendered } });
    const { scraper } = makeScraper({ fetcher, browser });

    const result = await scraper.scrape({ url: URL, renderJs: true });

    expect(result.rendered).toBe(true);
    expect(browser.renderCalls).toHaveLength(1);
    // A plain fetch was NOT used when render was chosen up-front.
    expect(fetcher.calls).toHaveLength(0);
    expect(result.content).toContain('JS produced this content');
  });

  it('auto-escalates to the browser when a plain fetch returns a thin body (Req 14.2)', async () => {
    // A near-empty SPA shell — too little text to be the real content.
    const thin = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
    const rendered = buildHtmlPage({ main: '<p>Hydrated client-rendered article body.'.padEnd(260, '.') + '</p>' });
    const fetcher = new FakePageFetcher({ [URL]: { html: thin } });
    const browser = new FakeBrowserEngine({ [URL]: { html: rendered } });
    const { scraper } = makeScraper({ fetcher, browser });

    const result = await scraper.scrape({ url: URL });

    expect(fetcher.calls).toHaveLength(1); // plain fetch tried first...
    expect(browser.renderCalls).toHaveLength(1); // ...then escalated.
    expect(result.rendered).toBe(true);
    expect(result.content).toContain('Hydrated client-rendered article body');
  });

  it('does NOT escalate a content-rich plain fetch', async () => {
    const rich = buildHtmlPage({ main: '<p>This page already has plenty of readable content. '.padEnd(300, 'y') + '</p>' });
    const fetcher = new FakePageFetcher({ [URL]: { html: rich } });
    const browser = new FakeBrowserEngine();
    const { scraper } = makeScraper({ fetcher, browser });

    const result = await scraper.scrape({ url: URL });

    expect(result.rendered).toBe(false);
    expect(browser.renderCalls).toHaveLength(0);
  });

  it('captures a screenshot via the browser when requested (Req 14.4)', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const browser = new FakeBrowserEngine({ [URL]: { html: buildHtmlPage() } });
    const { scraper } = makeScraper({ fetcher, browser });

    const result = await scraper.scrape({ url: URL, screenshot: true });

    expect(result.rendered).toBe(true);
    expect(result.screenshot).toBeDefined();
    expect(result.screenshot?.mimeType).toBe('image/png');
    expect(browser.renderCalls[0]?.options?.screenshot).toBe(true);
  });

  it('does not auto-escalate when autoEscalateToBrowser is disabled', async () => {
    const thin = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
    const fetcher = new FakePageFetcher({ [URL]: { html: thin } });
    const browser = new FakeBrowserEngine();
    const { scraper } = makeScraper({ fetcher, browser, autoEscalateToBrowser: false });

    const result = await scraper.scrape({ url: URL });

    expect(result.rendered).toBe(false);
    expect(browser.renderCalls).toHaveLength(0);
  });
});

describe('decideRenderMode (pure fetch-vs-render decision, Req 14.2, 14.4)', () => {
  it('chooses render when renderJs is set', () => {
    expect(decideRenderMode({ renderJs: true, screenshot: false })).toBe('render');
  });

  it('chooses render when a screenshot is requested', () => {
    expect(decideRenderMode({ renderJs: false, screenshot: true })).toBe('render');
  });

  it('chooses fetch for a plain request', () => {
    expect(decideRenderMode({ renderJs: false, screenshot: false })).toBe('fetch');
  });
});

describe('WebScraper — error handling (Req 14.1)', () => {
  it('raises a typed ScrapeFetchError for an unreachable page (network failure)', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { networkError: 'ECONNREFUSED' } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const error = await scraper.scrape({ url: URL }).then(
      () => {
        throw new Error('expected scrape to fail for an unreachable page');
      },
      (caught: unknown) => caught as ScrapeFetchError,
    );

    expect(error).toBeInstanceOf(ScrapeFetchError);
    expect(error.url).toBe(URL);
    expect(error.status).toBeUndefined();
    const platform = error.toPlatformError('corr-net');
    expect(platform.category).toBe('provider_unavailable');
    expect(platform.code).toBe('SCRAPE_FETCH_FAILED');
    expect(platform.retriable).toBe(true);
  });

  it('raises a typed ScrapeFetchError for a blocked page (non-OK HTTP status)', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { status: 403, html: 'Forbidden' } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    const error = await scraper.scrape({ url: URL }).then(
      () => {
        throw new Error('expected scrape to fail for a blocked page');
      },
      (caught: unknown) => caught as ScrapeFetchError,
    );

    expect(error).toBeInstanceOf(ScrapeFetchError);
    expect(error.status).toBe(403);
    expect(error.toPlatformError('c').details).toMatchObject({ status: 403 });
  });

  it('rejects a non-absolute / non-http URL with InvalidUrlError before any I/O', async () => {
    const fetcher = new FakePageFetcher();
    const { scraper, robots } = makeScraper({ fetcher, browser: undefined });

    await expect(scraper.scrape({ url: 'file:///etc/passwd' })).rejects.toBeInstanceOf(InvalidUrlError);
    await expect(scraper.scrape({ url: 'not a url' })).rejects.toBeInstanceOf(InvalidUrlError);
    // No robots/fetch I/O happened for the invalid URLs.
    expect(robots.calls).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('maps a browser render failure to a typed BrowserAutomationError', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const browser = new FakeBrowserEngine({ [URL]: { renderError: 'navigation timeout' } });
    const { scraper } = makeScraper({ fetcher, browser });

    const error = await scraper.scrape({ url: URL, renderJs: true }).then(
      () => {
        throw new Error('expected a browser render failure');
      },
      (caught: unknown) => caught as BrowserAutomationError,
    );

    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect(error.url).toBe(URL);
    expect(error.toPlatformError('c').code).toBe('BROWSER_AUTOMATION_FAILED');
  });

  it('fails closed when a render is required but no browser engine is configured', async () => {
    const fetcher = new FakePageFetcher({ [URL]: { html: buildHtmlPage() } });
    const { scraper } = makeScraper({ fetcher, browser: undefined });

    await expect(scraper.scrape({ url: URL, screenshot: true })).rejects.toBeInstanceOf(
      BrowserAutomationError,
    );
    await expect(scraper.scrape({ url: URL, renderJs: true })).rejects.toBeInstanceOf(
      BrowserAutomationError,
    );
  });
});

describe('BrowserAutomation — ordered actions (Req 14.7)', () => {
  it('runs the requested actions in order and returns per-action results', async () => {
    const browser = new FakeBrowserEngine({ [URL]: { html: '<html><body>done</body></html>' } });
    const automation = new BrowserAutomation({ browser });

    const result = await automation.run(URL, [
      { type: 'click', selector: '#accept' },
      { type: 'type', selector: '#q', text: 'auxify' },
      { type: 'scroll', y: 600 },
      { type: 'screenshot' },
      { type: 'extract', selector: '.result' },
    ]);

    expect(result.actions.map((a) => a.type)).toEqual([
      'click',
      'type',
      'scroll',
      'screenshot',
      'extract',
    ]);
    expect(result.actions[1]?.value).toBe('auxify');
    expect(result.actions[4]?.value).toBe('extracted:.result');
    expect(result.screenshots).toHaveLength(1);
    expect(browser.runCalls).toHaveLength(1);
    expect(browser.runCalls[0]?.actions).toHaveLength(5);
  });

  it('rejects an invalid URL before driving the browser', async () => {
    const browser = new FakeBrowserEngine();
    const automation = new BrowserAutomation({ browser });

    await expect(automation.run('javascript:alert(1)', [])).rejects.toBeInstanceOf(InvalidUrlError);
    expect(browser.runCalls).toHaveLength(0);
  });

  it('maps an engine failure to a typed BrowserAutomationError', async () => {
    const browser = new FakeBrowserEngine({ [URL]: { renderError: 'element not found' } });
    const automation = new BrowserAutomation({ browser });

    const error = await automation.run(URL, [{ type: 'click', selector: '#x' }]).then(
      () => {
        throw new Error('expected automation to fail');
      },
      (caught: unknown) => caught as BrowserAutomationError,
    );
    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect(error.toPlatformError('c').category).toBe('provider_unavailable');
  });
});
