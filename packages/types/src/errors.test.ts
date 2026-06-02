import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ERROR_CATEGORIES,
  ERROR_CATEGORY_HTTP_STATUS,
  RETRIABLE_ERROR_CATEGORIES,
  createPlatformError,
  httpStatusForError,
  isRetriableCategory,
  ok,
  err,
  isOk,
  isErr,
  type ErrorCategory,
  type PlatformError,
} from './errors';

describe('typed error model', () => {
  it('maps every category to an HTTP status', () => {
    for (const category of ERROR_CATEGORIES) {
      expect(ERROR_CATEGORY_HTTP_STATUS[category]).toBeGreaterThanOrEqual(400);
      expect(ERROR_CATEGORY_HTTP_STATUS[category]).toBeLessThan(600);
    }
  });

  it('treats exactly rate_limited, provider_unavailable, and internal as retriable', () => {
    expect([...RETRIABLE_ERROR_CATEGORIES].sort()).toEqual(
      ['internal', 'provider_unavailable', 'rate_limited'].sort(),
    );
    expect(isRetriableCategory('rate_limited')).toBe(true);
    expect(isRetriableCategory('authorization')).toBe(false);
  });

  it('defaults retriable from the category and surfaces the correct HTTP status', () => {
    const rateLimited = createPlatformError({
      category: 'rate_limited',
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      correlationId: 'corr-1',
      retryAfterSeconds: 30,
    });
    expect(rateLimited.retriable).toBe(true);
    expect(rateLimited.retryAfterSeconds).toBe(30);
    expect(httpStatusForError(rateLimited)).toBe(429);

    const denied = createPlatformError({
      category: 'authorization',
      code: 'MODEL_NOT_AUTHORIZED',
      message: 'Access denied',
      correlationId: 'corr-2',
    });
    expect(denied.retriable).toBe(false);
    expect(httpStatusForError(denied)).toBe(403);
  });

  it('allows overriding retriable for transient internal errors', () => {
    const transient = createPlatformError({
      category: 'internal',
      code: 'TRANSIENT',
      message: 'Temporary failure',
      correlationId: 'corr-3',
      retriable: true,
    });
    expect(transient.retriable).toBe(true);

    const fatal = createPlatformError({
      category: 'internal',
      code: 'FATAL',
      message: 'Unexpected error',
      correlationId: 'corr-4',
      retriable: false,
    });
    expect(fatal.retriable).toBe(false);
  });

  it('omits optional fields when not provided', () => {
    const error = createPlatformError({
      category: 'not_found',
      code: 'NOT_FOUND',
      message: 'Missing',
      correlationId: 'corr-5',
    });
    expect('details' in error).toBe(false);
    expect('retryAfterSeconds' in error).toBe(false);
  });
});

describe('Result discriminated union', () => {
  it('narrows ok and err results via type guards', () => {
    const success = ok(42);
    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    if (isOk(success)) {
      expect(success.value).toBe(42);
    }

    const error: PlatformError = createPlatformError({
      category: 'validation',
      code: 'BAD_INPUT',
      message: 'Invalid',
      correlationId: 'corr-6',
    });
    const failure = err(error);
    expect(isErr(failure)).toBe(true);
    expect(isOk(failure)).toBe(false);
    if (isErr(failure)) {
      expect(failure.error.code).toBe('BAD_INPUT');
    }
  });
});

const categoryArb: fc.Arbitrary<ErrorCategory> = fc.constantFrom(...ERROR_CATEGORIES);

describe('typed error model (property-based)', () => {
  it('createPlatformError always defaults retriable to the category default when not overridden', () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.string({ minLength: 1 }),
        fc.string(),
        fc.string({ minLength: 1 }),
        (category, code, message, correlationId) => {
          const error = createPlatformError({ category, code, message, correlationId });
          return error.retriable === isRetriableCategory(category);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('httpStatusForError is always a defined 4xx/5xx status for every category', () => {
    fc.assert(
      fc.property(categoryArb, fc.string({ minLength: 1 }), (category, correlationId) => {
        const error = createPlatformError({
          category,
          code: 'CODE',
          message: 'msg',
          correlationId,
        });
        const status = httpStatusForError(error);
        return Number.isInteger(status) && status >= 400 && status < 600;
      }),
      { numRuns: 100 },
    );
  });

  it('explicit retriable override is always honored regardless of category', () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.boolean(),
        fc.string({ minLength: 1 }),
        (category, retriable, correlationId) => {
          const error = createPlatformError({
            category,
            code: 'CODE',
            message: 'msg',
            correlationId,
            retriable,
          });
          return error.retriable === retriable;
        },
      ),
      { numRuns: 100 },
    );
  });
});
