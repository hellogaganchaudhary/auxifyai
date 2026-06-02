/**
 * Unit tests for the Web_Scraper's pure helpers (Req 14.1, 14.3, 14.5, 14.6).
 *
 * These pin down the building blocks the {@link WebScraper} composes:
 *
 *  - robots.txt parsing + path gating, including longest-match precedence and
 *    `Allow` carve-outs (Req 14.5);
 *  - the per-domain interval rate limiter spacing same-host requests while
 *    leaving different hosts independent (Req 14.6);
 *  - URL parsing/validation and relative-link resolution;
 *  - HTML→Markdown conversion, metadata/table/link extraction, boilerplate
 *    stripping, and whitespace normalization (Req 14.1, 14.3).
 */

import { describe, expect, it } from 'vitest';

import {
  decodeEntities,
  extractLinks,
  extractMetadata,
  extractTables,
  htmlToMarkdown,
  htmlToText,
  metadataToMarkdown,
  normalizeWhitespace,
  selectMainContent,
  stripNonContent,
  tablesToMarkdown,
} from './extraction.js';
import { ManualClock, RecordingWaiter } from './fakes.js';
import { IntervalRateLimiter, NoopRateLimiter } from './rate-limit.js';
import { isPathAllowed, matchingRule, parseRobots } from './robots.js';
import { parseScrapeUrl, resolveUrl } from './url.js';

describe('parseRobots / isPathAllowed (Req 14.5)', () => {
  it('treats an empty or absent body as allow-all', () => {
    expect(isPathAllowed(parseRobots(null, 'AuxifyBot'), '/anything')).toBe(true);
    expect(isPathAllowed(parseRobots('', 'AuxifyBot'), '/anything')).toBe(true);
  });

  it('disallows a path under a Disallow prefix for the wildcard agent', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private/', 'AuxifyBot');
    expect(isPathAllowed(rules, '/private/secret')).toBe(false);
    expect(isPathAllowed(rules, '/public/post')).toBe(true);
  });

  it('applies longest-match precedence with an Allow carve-out', () => {
    const body = 'User-agent: *\nDisallow: /docs/\nAllow: /docs/public/';
    const rules = parseRobots(body, 'AuxifyBot');
    expect(isPathAllowed(rules, '/docs/private/x')).toBe(false);
    expect(isPathAllowed(rules, '/docs/public/x')).toBe(true);
    expect(matchingRule(rules, '/docs/public/x')?.allow).toBe(true);
  });

  it('prefers a more specific agent group over the wildcard group', () => {
    const body =
      'User-agent: *\nDisallow: /\n\nUser-agent: AuxifyBot\nDisallow: /admin/';
    const rules = parseRobots(body, 'AuxifyBot/1.0');
    // The AuxifyBot group applies: only /admin/ is disallowed.
    expect(isPathAllowed(rules, '/admin/panel')).toBe(false);
    expect(isPathAllowed(rules, '/articles/post')).toBe(true);
  });

  it('treats an empty Disallow as allow-all', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', 'AuxifyBot');
    expect(isPathAllowed(rules, '/anything')).toBe(true);
  });

  it('supports the * wildcard and $ anchor in rule paths', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$', 'AuxifyBot');
    expect(isPathAllowed(rules, '/files/report.pdf')).toBe(false);
    expect(isPathAllowed(rules, '/files/report.pdf?x=1')).toBe(true);
    expect(isPathAllowed(rules, '/files/report.html')).toBe(true);
  });
});

describe('IntervalRateLimiter (Req 14.6)', () => {
  it('permits the first request to a host immediately, then spaces subsequent ones', async () => {
    const clock = new ManualClock(1000);
    const waiter = new RecordingWaiter(clock);
    const limiter = new IntervalRateLimiter({ minIntervalMs: 500, clock, waiter });

    await limiter.acquire('example.com'); // first: no wait
    await limiter.acquire('example.com'); // second: must wait 500ms
    await limiter.acquire('example.com'); // third: another 500ms

    expect(waiter.waits).toEqual([500, 500]);
  });

  it('keeps different hosts independent', async () => {
    const clock = new ManualClock(0);
    const waiter = new RecordingWaiter(clock);
    const limiter = new IntervalRateLimiter({ minIntervalMs: 1000, clock, waiter });

    await limiter.acquire('a.com');
    await limiter.acquire('b.com');

    // Neither first request waits, because each host is fresh.
    expect(waiter.waits).toEqual([]);
  });

  it('NoopRateLimiter never delays', async () => {
    const limiter = new NoopRateLimiter();
    await expect(limiter.acquire('x.com')).resolves.toBeUndefined();
  });
});

describe('parseScrapeUrl / resolveUrl', () => {
  it('parses an absolute http(s) URL into origin/host/path', () => {
    const parsed = parseScrapeUrl('https://Example.com/a/b?q=1#frag');
    expect(parsed?.origin).toBe('https://example.com');
    expect(parsed?.host).toBe('example.com');
    expect(parsed?.pathAndQuery).toBe('/a/b?q=1');
  });

  it('rejects non-http(s) and malformed URLs', () => {
    expect(parseScrapeUrl('file:///etc/passwd')).toBeNull();
    expect(parseScrapeUrl('javascript:alert(1)')).toBeNull();
    expect(parseScrapeUrl('not a url')).toBeNull();
  });

  it('resolves relative links against a base and returns the original when unresolvable', () => {
    expect(resolveUrl('/x/y', 'https://example.com/a')).toBe('https://example.com/x/y');
    expect(resolveUrl('https://other.com/z', 'https://example.com/a')).toBe('https://other.com/z');
  });
});

describe('content extraction and normalization (Req 14.1, 14.3)', () => {
  it('decodes HTML entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x41;')).toBe("a & b <c> 'd' A");
  });

  it('collapses whitespace and trims (normalizeWhitespace)', () => {
    // Tabs between b and c collapse to a single space; the 4 newlines before d
    // collapse to a paragraph break.
    expect(normalizeWhitespace('  a   b\t\tc\n\n\n\nd  ')).toBe('a b c\n\nd');
    // A single newline is preserved as a single newline (spaces around it trimmed).
    expect(normalizeWhitespace('line1   \n   line2')).toBe('line1\nline2');
  });

  it('strips tags to plain text (htmlToText)', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script/style content entirely (stripNonContent)', () => {
    const out = stripNonContent('<p>keep</p><script>evil()</script><style>.x{}</style>');
    expect(out).toContain('keep');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('.x{}');
  });

  it('selects <main> as the main content and strips boilerplate by attribute', () => {
    const html =
      '<body><nav>Menu</nav><main><p>Body</p><div class="ad-banner">Ad</div></main><footer>F</footer></body>';
    const main = selectMainContent(html);
    expect(htmlToText(main)).toContain('Body');
    expect(htmlToText(main)).not.toContain('Ad');
  });

  it('converts headings, lists, links, and emphasis to Markdown', () => {
    const html =
      '<h2>Title</h2><p>Intro <strong>bold</strong> and <em>italic</em>.</p><ul><li>One</li><li>Two</li></ul><a href="/x">link</a>';
    const md = htmlToMarkdown(html, 'https://example.com/');
    expect(md).toContain('## Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('- One');
    expect(md).toContain('[link](https://example.com/x)');
  });

  it('renders a javascript: link as inert text, not an href', () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">x</a>', 'https://example.com/');
    expect(md).toBe('x');
    expect(md).not.toContain('javascript:');
  });

  it('extracts Open Graph and meta tags into PageMetadata', () => {
    const html = `<html lang="en"><head>
      <title>Fallback</title>
      <meta property="og:title" content="OG Title" />
      <meta name="description" content="A description" />
      <meta property="og:site_name" content="Site" />
      <link rel="canonical" href="https://example.com/canon" />
    </head><body></body></html>`;
    const meta = extractMetadata(html);
    expect(meta.title).toBe('OG Title');
    expect(meta.description).toBe('A description');
    expect(meta.siteName).toBe('Site');
    expect(meta.canonicalUrl).toBe('https://example.com/canon');
    expect(meta.language).toBe('en');
  });

  it('extracts a table with header detection', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const tables = extractTables(html);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toEqual(['A', 'B']);
    expect(tables[0]?.rows).toEqual([['1', '2']]);
    expect(tablesToMarkdown(tables)).toContain('| A | B |');
  });

  it('extracts and resolves links, skipping fragments and javascript:', () => {
    const html =
      '<a href="/rel">Rel</a><a href="#top">Top</a><a href="javascript:void(0)">JS</a><a href="https://x.io/p">Ext</a>';
    const links = extractLinks(html, 'https://example.com/base');
    expect(links.map((l) => l.href)).toEqual([
      'https://example.com/rel',
      'https://x.io/p',
    ]);
  });

  it('renders metadata as a Markdown key/value block', () => {
    const md = metadataToMarkdown({ title: 'T', description: 'D' });
    expect(md).toContain('- **title**: T');
    expect(md).toContain('- **description**: D');
  });
});
