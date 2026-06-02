/**
 * Browser_Automation: run an ordered list of interactive browser actions
 * (Req 14.7).
 *
 * {@link BrowserAutomation.run} navigates to a URL and executes the requested
 * click/type/scroll/screenshot/extract actions *in order* through the injected
 * {@link BrowserEngine}, returning each action's result, the final page HTML,
 * and every captured screenshot. The URL is validated up-front and engine
 * failures are mapped to a typed {@link BrowserAutomationError} so an internal
 * exception is never leaked (Req 34.7).
 *
 * The browser is an injectable port, so this component is fully unit-testable
 * with the {@link import('./fakes.js').FakeBrowserEngine} and never drives a
 * real browser here.
 */

import { BrowserAutomationError, InvalidUrlError } from './errors.js';
import type { BrowseAction, BrowseResult, BrowserEngine } from './types.js';
import { parseScrapeUrl } from './url.js';

/** Construction options for {@link BrowserAutomation}. */
export interface BrowserAutomationOptions {
  /** The headless-browser engine that executes the actions (Req 14.7). */
  browser: BrowserEngine;
}

/**
 * The Browser_Automation component (Req 14.7).
 */
export class BrowserAutomation {
  private readonly browser: BrowserEngine;

  constructor(options: BrowserAutomationOptions) {
    this.browser = options.browser;
  }

  /**
   * Run the ordered `actions` against `url` and return the outcome (Req 14.7).
   *
   * @param url The absolute URL to drive.
   * @param actions The ordered actions (click/type/scroll/screenshot/extract).
   * @returns The per-action results, final HTML, and captured screenshots.
   * @throws {@link InvalidUrlError} when the URL is not an absolute http(s) URL.
   * @throws {@link BrowserAutomationError} when the engine fails.
   */
  async run(url: string, actions: readonly BrowseAction[]): Promise<BrowseResult> {
    const parsed = parseScrapeUrl(url);
    if (parsed === null) {
      throw new InvalidUrlError(url);
    }
    try {
      const result = await this.browser.run(parsed.href, actions);
      return result;
    } catch (cause) {
      throw new BrowserAutomationError(parsed.href, safeReason(cause));
    }
  }
}

/** Reduce an unknown thrown value to a safe, secret-free reason string (Req 34.7). */
function safeReason(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === 'string') {
    return cause.message;
  }
  return 'browser error';
}
