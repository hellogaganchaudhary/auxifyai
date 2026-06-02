/**
 * Property-based test for PII masking on both the input and output paths.
 *
 * Feature: auxify-ai-platform, Property 47: PII is masked on both input and
 * output paths.
 *
 * Design statement (Property 47): "For any model input and any model output,
 * all personally identifiable information detected by the Content_Safety_Filter
 * is masked before the input is sent to the model and before the output is
 * delivered to the user."
 *
 * Validates: Requirements 36.1, 36.3
 *
 * We exercise two layers of the masking guarantee:
 *   1. The pure {@link maskPiiSpans} core over arbitrary, sorted, non-overlapping
 *      spans (the cleanest unit) — every detected PII literal is replaced by its
 *      typed mask token and no longer appears in the result.
 *   2. End-to-end through {@link ContentSafetyFilter.screenInput} (input path,
 *      Req 36.1) and {@link ContentSafetyFilter.scanOutput} (output path,
 *      Req 36.3), driven by a {@link FakeSafetyClassifier} that reports the
 *      generated spans for the generated content.
 *
 * The generator interleaves benign filler (lowercase letters and spaces) with
 * distinctive PII tokens whose alphabet (`#`, `-`, digits, uppercase letters)
 * is disjoint from the filler and made unique per span, so after masking the
 * absence of every PII literal is a meaningful, decisive assertion. Spans are
 * built left-to-right, so they are always sorted and non-overlapping — exactly
 * the contract {@link maskPiiSpans} guarantees (adjacent spans, with empty
 * filler between them, are still covered).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ContentSafetyFilter, maskPiiSpans, type PiiSpan } from './index.js';
import {
  CapturingAuditRecorder,
  CapturingReviewQueue,
  FakeSafetyClassifier,
  makeInput,
  makeOutput,
} from './fakes.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** Benign filler alphabet — lowercase letters and spaces only. */
const FILLER_CHARS = 'abcdefghijklmnopqrstuvwxyz '.split('');

/** Possibly-empty benign filler placed between PII tokens. */
const fillerArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...FILLER_CHARS), { minLength: 0, maxLength: 6 })
  .map((chars) => chars.join(''));

/** A small pool of PII type labels; used only to compose the mask token. */
const PII_TYPES = ['email', 'phone', 'ssn', 'credit_card', 'address'] as const;

/**
 * The body alphabet of a distinctive PII token. Uppercase + digits never appear
 * in the filler, so a PII literal can only ever occur at its own span.
 */
const PII_CORE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** A non-empty PII token body. */
const piiCoreArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...PII_CORE_CHARS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

/** One generated segment: benign filler, optionally followed by a PII token. */
interface PartSpec {
  filler: string;
  pii: { type: string; core: string } | undefined;
}

const partArb: fc.Arbitrary<PartSpec> = fc.record({
  filler: fillerArb,
  pii: fc.option(fc.record({ type: fc.constantFrom(...PII_TYPES), core: piiCoreArb }), {
    nil: undefined,
  }),
});

/** A generated content string together with the spans/literals located in it. */
interface PiiText {
  /** The assembled content. */
  text: string;
  /** The sorted, non-overlapping spans a classifier reports for {@link text}. */
  spans: PiiSpan[];
  /** The exact PII literal substrings at each span, in order. */
  values: string[];
}

/**
 * Build a content string by concatenating parts left-to-right, recording the
 * absolute `[start, end)` offset of each embedded PII token. Each token is made
 * globally unique by embedding its part index, so it occurs exactly once.
 */
const piiTextArb: fc.Arbitrary<PiiText> = fc
  .array(partArb, { minLength: 0, maxLength: 8 })
  .map((parts) => {
    let text = '';
    const spans: PiiSpan[] = [];
    const values: string[] = [];
    parts.forEach((part, index) => {
      text += part.filler;
      if (part.pii !== undefined) {
        const value = `#${index}-${part.pii.core}#`;
        const start = text.length;
        text += value;
        spans.push({ type: part.pii.type, start, end: text.length });
        values.push(value);
      }
    });
    return { text, spans, values };
  });

/** Reconstruct the mask token {@link maskPiiSpans} emits for a PII type label. */
function expectedToken(type: string): string {
  const normalized = type.trim().toUpperCase().replace(/\s+/g, '_');
  return `[REDACTED_${normalized.length > 0 ? normalized : 'PII'}]`;
}

/** Assert that no PII literal survives in `masked` and every span was tokenized. */
function assertFullyMasked(masked: string, original: PiiText): void {
  const { text, spans, values } = original;
  // Every detected PII literal is gone from the masked content.
  for (const value of values) {
    expect(masked.includes(value)).toBe(false);
  }
  // Each span contributes exactly one mask token of its type.
  for (const span of spans) {
    expect(masked).toContain(expectedToken(span.type));
  }
  const tokenCount = masked.split('[REDACTED_').length - 1;
  expect(tokenCount).toBe(spans.length);
  // With nothing to mask the content is returned verbatim.
  if (spans.length === 0) {
    expect(masked).toBe(text);
  }
}

describe('Feature: auxify-ai-platform, Property 47: PII is masked on both input and output paths', () => {
  it('maskPiiSpans masks every detected PII span so no literal survives, for any sorted non-overlapping spans (Validates: Requirements 36.1, 36.3)', () => {
    fc.assert(
      fc.property(piiTextArb, (generated) => {
        const masked = maskPiiSpans(generated.text, generated.spans);
        assertFullyMasked(masked, generated);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('screenInput masks every detected PII span before the input is sent to the model (Validates: Requirements 36.1)', async () => {
    await fc.assert(
      fc.asyncProperty(piiTextArb, async (generated) => {
        const classifier = new FakeSafetyClassifier({
          [generated.text]: { piiSpans: generated.spans },
        });
        const filter = new ContentSafetyFilter({
          classifier,
          auditRecorder: new CapturingAuditRecorder(),
          reviewQueue: new CapturingReviewQueue(),
        });

        const screened = await filter.screenInput(makeInput({ userContent: generated.text }));

        // PII-only content is not blocked, so it would proceed to the model...
        expect(screened.decision.blocked).toBe(false);
        // ...and the content that would be forwarded is fully masked (Req 36.1).
        expect(screened.userContent).toBe(maskPiiSpans(generated.text, generated.spans));
        assertFullyMasked(screened.userContent, generated);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('scanOutput masks every detected PII span before the output is delivered to the user (Validates: Requirements 36.3)', async () => {
    await fc.assert(
      fc.asyncProperty(piiTextArb, async (generated) => {
        const classifier = new FakeSafetyClassifier({
          [generated.text]: { piiSpans: generated.spans },
        });
        const filter = new ContentSafetyFilter({
          classifier,
          auditRecorder: new CapturingAuditRecorder(),
          reviewQueue: new CapturingReviewQueue(),
        });

        const scanned = await filter.scanOutput(makeOutput({ content: generated.text }));

        expect(scanned.decision.blocked).toBe(false);
        // The content delivered to the user is fully masked (Req 36.3).
        expect(scanned.content).toBe(maskPiiSpans(generated.text, generated.spans));
        assertFullyMasked(scanned.content, generated);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
