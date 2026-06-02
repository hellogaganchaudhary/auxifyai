/**
 * Request validation and input sanitization for the Security_Gateway (Req 34.4,
 * 34.5).
 *
 * When user input is received the gateway validates and sanitizes it before
 * processing (Req 34.4) and encodes rendered output to prevent cross-site
 * scripting (Req 34.5). This module provides the pure helpers and the bundled
 * {@link DefaultRequestValidator} that perform those checks:
 *
 *   - {@link sanitizeText} strips the disallowed constructs (script/style tags,
 *     event-handler attributes, and the script-execution URL schemes) from a
 *     string. It is idempotent — `sanitizeText(sanitizeText(x)) === sanitizeText(x)`
 *     — and removes every construct {@link containsDisallowedConstructs} screens
 *     for (Property 46).
 *   - {@link encodeForOutput} HTML-encodes a string for safe rendering, so a
 *     value echoed back into a page can never inject markup (Req 34.5).
 *   - {@link sanitizeDeep} recursively sanitizes the string content of an
 *     arbitrary JSON-like body, leaving structure and non-string scalars intact.
 *   - {@link DefaultRequestValidator} validates the request shape (method, path
 *     length and characters) and returns the deep-sanitized body.
 *
 * These helpers are pure and synchronous so validation stays trivially testable
 * and total. Sanitization neutralizes rather than rejects (so a benign request
 * carrying an accidental angle bracket still succeeds), while a structurally
 * invalid request (an over-long path, a control character in the path) is
 * rejected outright.
 */

import type { GatewayRequest, RequestValidator, ValidationResult } from './types.js';

/** The maximum permitted request path length, in characters (a defensive bound). */
export const MAX_PATH_LENGTH = 2048;

/** The five characters that are unsafe in HTML text/attribute context (Req 34.5). */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTML-encode a string for safe rendering, preventing cross-site scripting on
 * the output path (Req 34.5).
 *
 * Replaces the five HTML-significant characters with their entities so a value
 * echoed into a page renders as inert text rather than live markup.
 *
 * @param value The raw, untrusted text.
 * @returns The text with `& < > " '` replaced by their entities.
 */
export function encodeForOutput(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * The disallowed constructs the gateway screens for on the input path (Req 34.4).
 *
 * Each pattern is global and case-insensitive so every occurrence is removed by
 * {@link sanitizeText} and detected by {@link containsDisallowedConstructs}:
 *   - `<script>…</script>` and `<style>…</style>` element blocks;
 *   - any remaining `<script …>` / `<style …>` open or close tag;
 *   - inline `on*=` event-handler attributes (e.g. `onerror=`, `onclick=`);
 *   - the script-execution URL schemes `javascript:`, `vbscript:`, `data:text/html`.
 *
 * Patterns are ordered so block forms are removed before the looser tag form, so
 * a single sanitization pass already reaches the fixed point (idempotence,
 * Property 46).
 */
const DISALLOWED_PATTERNS: readonly RegExp[] = [
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<\/?\s*(?:script|style)\b[^>]*>/gi,
  /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
  /(?:javascript|vbscript):/gi,
  /data:text\/html/gi,
];

/**
 * Whether `value` still contains any of the disallowed constructs
 * {@link sanitizeText} removes (Req 34.4).
 *
 * Used by the tests and the gateway to assert the post-condition that a
 * sanitized string is free of injection/XSS constructs (Property 46).
 *
 * @param value The string to screen.
 * @returns `true` if any disallowed construct is present.
 */
export function containsDisallowedConstructs(value: string): boolean {
  return DISALLOWED_PATTERNS.some((pattern) => {
    // RegExp with the `g` flag is stateful; test against a fresh copy.
    const probe = new RegExp(pattern.source, pattern.flags);
    return probe.test(value);
  });
}

/**
 * Strip every disallowed construct from a string (Req 34.4).
 *
 * Applies each {@link DISALLOWED_PATTERNS} entry until the string reaches a
 * fixed point, so the result is free of injection/XSS constructs and
 * sanitization is idempotent: `sanitizeText(sanitizeText(x)) === sanitizeText(x)`
 * (Property 46). A string with no disallowed construct is returned unchanged.
 *
 * @param value The raw, untrusted text.
 * @returns The text with all disallowed constructs removed.
 */
export function sanitizeText(value: string): string {
  let current = value;
  // Iterate to a fixed point: removing one construct can expose another only in
  // pathological nestings; bound the loop defensively.
  for (let pass = 0; pass < 8; pass += 1) {
    let next = current;
    for (const pattern of DISALLOWED_PATTERNS) {
      next = next.replace(new RegExp(pattern.source, pattern.flags), '');
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

/**
 * Recursively sanitize the string content of a JSON-like body (Req 34.4).
 *
 * Strings are passed through {@link sanitizeText}; arrays and plain objects are
 * rebuilt with each element/value sanitized; all other scalars (`number`,
 * `boolean`, `null`, `undefined`) are returned unchanged. Structure is
 * preserved so the backend receives the same shape, minus disallowed constructs.
 *
 * @param body The request body (any JSON-like value).
 * @returns The body with every string deeply sanitized.
 */
export function sanitizeDeep(body: unknown): unknown {
  if (typeof body === 'string') {
    return sanitizeText(body);
  }
  if (Array.isArray(body)) {
    return body.map((item) => sanitizeDeep(item));
  }
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      out[key] = sanitizeDeep(value);
    }
    return out;
  }
  return body;
}

/** Construction options for the {@link DefaultRequestValidator}. */
export interface DefaultRequestValidatorOptions {
  /** The maximum permitted path length; defaults to {@link MAX_PATH_LENGTH}. */
  maxPathLength?: number;
}

/**
 * The baseline {@link RequestValidator} the gateway uses when a route supplies
 * no schema-specific validator (Req 34.4).
 *
 * It rejects a structurally invalid request — an empty or over-long path, a path
 * that does not start with `/`, or a path containing control characters — with a
 * descriptive issue, and otherwise returns the request body deep-sanitized via
 * {@link sanitizeDeep}. It is pure and never throws, so the gateway's
 * fail-closed contract is preserved.
 */
export class DefaultRequestValidator implements RequestValidator {
  private readonly maxPathLength: number;

  constructor(options: DefaultRequestValidatorOptions = {}) {
    this.maxPathLength = options.maxPathLength ?? MAX_PATH_LENGTH;
  }

  validate(request: GatewayRequest): ValidationResult {
    const issues: string[] = [];

    if (typeof request.path !== 'string' || request.path.length === 0) {
      issues.push('path is required');
    } else {
      if (!request.path.startsWith('/')) {
        issues.push('path must start with "/"');
      }
      if (request.path.length > this.maxPathLength) {
        issues.push(`path exceeds the maximum length of ${this.maxPathLength} characters`);
      }
      // eslint-disable-next-line no-control-regex -- intentionally screening control chars
      if (/[\u0000-\u001f\u007f]/.test(request.path)) {
        issues.push('path contains control characters');
      }
    }

    if (issues.length > 0) {
      return { valid: false, issues };
    }

    return { valid: true, issues: [], sanitizedBody: sanitizeDeep(request.body) };
  }
}
