/**
 * HTML escaping and URL-safety helpers shared by the Output_Renderer (Req 8).
 *
 * Every renderer that emits an HTML representation (Markdown, code) routes
 * untrusted model text through {@link escapeHtml}/{@link escapeAttribute} so a
 * response can never inject markup or script into the rendered output (XSS
 * defence on the output path, consistent with Req 34.5). URL-bearing constructs
 * (Markdown links) additionally pass through {@link isSafeUrl} so only benign
 * schemes become real `href`s.
 *
 * These helpers are pure and synchronous so the whole renderer stays trivially
 * testable (Req 8.7 isolation is only meaningful if a single block render is a
 * pure, total function).
 */

/** The five characters that are unsafe in HTML text/attribute context. */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape the HTML-significant characters in `value` so it is safe to embed in
 * element text or an attribute value.
 *
 * @param value The raw, untrusted text.
 * @returns The text with `& < > " '` replaced by their entities.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 *
 * Identical to {@link escapeHtml} today (it already escapes `"`), but named
 * separately at the call sites that build attributes so intent is explicit.
 *
 * @param value The raw attribute value.
 * @returns The escaped attribute value.
 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/** URL schemes that must never become a live link (script execution vectors). */
const UNSAFE_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:'] as const;

/**
 * Decide whether a Markdown link target is safe to render as a real `href`.
 *
 * Relative URLs, fragments, and the usual benign schemes (`http`, `https`,
 * `mailto`, …) are allowed; the known script-execution schemes are rejected so
 * a link like `[x](javascript:alert(1))` renders as inert text instead of a
 * clickable script (Req 34.5).
 *
 * @param url The link target (already HTML-escaped when called from Markdown).
 * @returns `true` if the URL may be used as an `href`.
 */
export function isSafeUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return !UNSAFE_URL_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}
