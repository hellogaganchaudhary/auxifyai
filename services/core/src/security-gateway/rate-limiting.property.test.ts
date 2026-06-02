/**
 * Feature: auxify-ai-platform, Property 44: Rate limits are never exceeded per dimension.
 *
 * Validates: Requirements 14.6, 34.3, 45.7
 *
 * For any burst of requests against a configured rate limit — keyed per user,
 * per API key, per IP address, or per scraped domain — the number of requests
 * accepted within any single window never exceeds the configured limit, and
 * every excess request is rejected with a rate-limit decision. A fresh window
 * (the clock advanced past the configured window) resets the allowance, and
 * each dimension/key is throttled independently of every other.
 *
 * The property is pinned primarily at the limiter port — it drives the bundled
 * {@link InMemoryRateLimiter} (the {@link RateLimiter} the gateway composes for
 * Req 34.3) directly, the cleanest unit to assert the count invariant on. It is
 * time-injected through a hand-controlled {@link ManualClock} so windows advance
 * deterministically. The four "dimensions" of Property 44 (per user / per API
 * key / per IP / per scraped domain) all flow through the same
 * `(dimension, id)` counter contract, so a single generated dimension + id pair
 * exercises the per-dimension guarantee uniformly. As a secondary check, the
 * full {@link SecurityGateway} rate-limit stage is shown to reject an over-limit
 * burst with the `rate_limited` denial code.
 *
 * To stay coupled to the real contract, the test imports the production
 * {@link RateLimiter} / {@link InMemoryRateLimiter}, the {@link SecurityGateway},
 * and the `RATE_LIMIT_DIMENSIONS` constant from the package's local barrel
 * (`../security-gateway/index.js`), and the manual clock + request/principal
 * builders directly from `./fakes.js` (the established convention).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryRateLimiter,
  RATE_LIMIT_DIMENSIONS,
  SecurityGateway,
  type RateLimit,
  type RateLimitDimension,
  type RateLimitKey,
} from '../security-gateway/index.js';
import {
  CapturingAuditRecorder,
  FakeAuthenticator,
  ManualClock,
  makePrincipal,
  makeRequest,
} from './fakes.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A rate-limit dimension drawn from the production set (per user / API key / IP). */
const dimensionArb: fc.Arbitrary<RateLimitDimension> = fc.constantFrom(...RATE_LIMIT_DIMENSIONS);

/** A non-empty counter id (a user id, API-key id, or IP). */
const idArb = fc.string({ minLength: 1, maxLength: 16 }).map((s) => `id-${s}`);

/** A positive request limit and a positive window length, in seconds. */
const limitArb: fc.Arbitrary<RateLimit> = fc.record({
  requestsPerWindow: fc.integer({ min: 1, max: 12 }),
  windowSeconds: fc.integer({ min: 1, max: 120 }),
});

/**
 * A burst plan: a dimension, a counter id, a limit, a burst size that may
 * exceed the limit, and a per-request inter-arrival gap (ms) kept strictly
 * below the window so every request lands in the same window.
 */
const burstArb = limitArb.chain((limit) =>
  fc.record({
    dimension: dimensionArb,
    id: idArb,
    limit: fc.constant(limit),
    burst: fc.integer({ min: 1, max: limit.requestsPerWindow * 3 + 5 }),
    // Strictly less than the window so all requests fall within one window.
    // windowSeconds >= 1, so the window in ms is >= 1000.
    gapMs: fc.integer({ min: 0, max: limit.windowSeconds * 1000 - 1 }),
  }),
);

// ---------------------------------------------------------------------------
// Property 44 — limiter-level (primary).
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 44: Rate limits are never exceeded per dimension', () => {
  it('accepts at most the configured limit within a single window and rejects every excess request (Validates: Requirements 14.6, 34.3, 45.7)', async () => {
    await fc.assert(
      fc.asyncProperty(burstArb, async ({ dimension, id, limit, burst, gapMs }) => {
        const limiter = new InMemoryRateLimiter();
        const clock = new ManualClock(0);
        const key: RateLimitKey = { dimension, id, limit };

        let accepted = 0;
        let rejected = 0;
        const windowMs = limit.windowSeconds * 1000;
        // Keep every request inside the *first* window: advance by gapMs only
        // while we have not yet crossed the window boundary.
        let elapsed = 0;

        for (let i = 0; i < burst; i++) {
          const decision = await limiter.consume([key], clock.now());
          if (decision.allowed) {
            accepted += 1;
          } else {
            rejected += 1;
            // A rejection names the offending dimension and hints a retry.
            expect(decision.exceededDimension).toBe(dimension);
            expect(decision.retryAfterSeconds ?? 0).toBeGreaterThan(0);
          }
          // Advance only if the next tick stays within the same window.
          if (i < burst - 1 && elapsed + gapMs < windowMs) {
            clock.advance(gapMs);
            elapsed += gapMs;
          }
        }

        // (1) Accepted never exceeds the configured limit within the window.
        expect(accepted).toBeLessThanOrEqual(limit.requestsPerWindow);
        // The accepted count is exactly min(burst, limit).
        expect(accepted).toBe(Math.min(burst, limit.requestsPerWindow));
        // (2) Every request beyond the limit is rejected — the counts partition.
        expect(accepted + rejected).toBe(burst);
        expect(rejected).toBe(Math.max(0, burst - limit.requestsPerWindow));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('resets the allowance once the clock advances past the window (Validates: Requirements 34.3, 45.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          dimension: dimensionArb,
          id: idArb,
          limit: limitArb,
          windows: fc.integer({ min: 2, max: 5 }),
        }),
        async ({ dimension, id, limit, windows }) => {
          const limiter = new InMemoryRateLimiter();
          const clock = new ManualClock(0);
          const key: RateLimitKey = { dimension, id, limit };
          const windowMs = limit.windowSeconds * 1000;

          for (let w = 0; w < windows; w++) {
            let accepted = 0;
            // Exhaust the limit, then attempt one extra — within this window.
            for (let i = 0; i < limit.requestsPerWindow + 2; i++) {
              const decision = await limiter.consume([key], clock.now());
              if (decision.allowed) accepted += 1;
            }
            // Each fresh window grants exactly the full allowance again.
            expect(accepted).toBe(limit.requestsPerWindow);
            // Advance strictly past the window so the next window is fresh.
            clock.advance(windowMs + 1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('throttles each dimension/key independently — one key being saturated never consumes another\'s allowance (Validates: Requirements 14.6, 34.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          dimension: dimensionArb,
          limit: limitArb,
          idA: idArb,
          idB: idArb,
        }),
        async ({ dimension, limit, idA, idB }) => {
          // Distinct ids per dimension (e.g. two different users / IPs / keys).
          fc.pre(idA !== idB);
          const limiter = new InMemoryRateLimiter();
          const clock = new ManualClock(0);
          const keyA: RateLimitKey = { dimension, id: idA, limit };
          const keyB: RateLimitKey = { dimension, id: idB, limit };

          // Saturate key A: exhaust its limit, then drive it well over.
          let acceptedA = 0;
          for (let i = 0; i < limit.requestsPerWindow + 3; i++) {
            if ((await limiter.consume([keyA], clock.now())).allowed) acceptedA += 1;
          }
          expect(acceptedA).toBe(limit.requestsPerWindow);
          // A is now denied.
          expect((await limiter.consume([keyA], clock.now())).allowed).toBe(false);

          // Key B (same dimension, different id) still has its full allowance.
          let acceptedB = 0;
          for (let i = 0; i < limit.requestsPerWindow; i++) {
            if ((await limiter.consume([keyB], clock.now())).allowed) acceptedB += 1;
          }
          expect(acceptedB).toBe(limit.requestsPerWindow);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('admits nothing and counts nothing when any one key in a multi-key request is over its limit (Validates: Requirements 34.3, 45.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // The user limit is >= 2 so a single admitted request never saturates
          // it; only the tight (limit-1) IP key is over after the first request.
          limit: fc.record({
            requestsPerWindow: fc.integer({ min: 2, max: 12 }),
            windowSeconds: fc.integer({ min: 1, max: 120 }),
          }),
          idUser: idArb,
          idIp: idArb,
        }),
        async ({ limit, idUser, idIp }) => {
          const limiter = new InMemoryRateLimiter();
          const clock = new ManualClock(0);
          // The IP key is given a tiny limit so it saturates first; the user key
          // is generous. consume() is all-or-nothing across the supplied keys.
          const tightIp: RateLimit = { requestsPerWindow: 1, windowSeconds: limit.windowSeconds };
          const userKey: RateLimitKey = { dimension: 'user', id: idUser, limit };
          const ipKey: RateLimitKey = { dimension: 'ip', id: idIp, limit: tightIp };

          // First request admits (both keys under their limits).
          expect((await limiter.consume([userKey, ipKey], clock.now())).allowed).toBe(true);
          // Second is denied because the IP key is now saturated.
          const denied = await limiter.consume([userKey, ipKey], clock.now());
          expect(denied.allowed).toBe(false);
          expect(denied.exceededDimension).toBe('ip');

          // The denied request must NOT have counted against the user key: the
          // user alone still has (limit - 1) of its allowance left.
          let acceptedUser = 0;
          for (let i = 0; i < limit.requestsPerWindow; i++) {
            if ((await limiter.consume([userKey], clock.now())).allowed) acceptedUser += 1;
          }
          expect(acceptedUser).toBe(limit.requestsPerWindow - 1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Property 44 — gateway-level (secondary): the rate-limit stage rejects an
  // over-limit burst with the `rate_limited` denial code (Req 34.3, 45.7).
  // -------------------------------------------------------------------------

  it('the SecurityGateway rate-limit stage rejects every over-limit request with a rate_limited denial (Validates: Requirements 34.3, 45.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ipLimit: fc.integer({ min: 1, max: 8 }),
          burst: fc.integer({ min: 1, max: 20 }),
        }),
        async ({ ipLimit, burst }) => {
          const clock = new ManualClock(0);
          const gateway = new SecurityGateway({
            auditRecorder: new CapturingAuditRecorder(),
            authenticator: new FakeAuthenticator(),
            rateLimiter: new InMemoryRateLimiter(),
            rateLimitConfig: {
              user: { requestsPerWindow: 100000, windowSeconds: 60 },
              apiKey: { requestsPerWindow: 100000, windowSeconds: 60 },
              ip: { requestsPerWindow: ipLimit, windowSeconds: 60 },
            },
            clock,
          });

          // A burst from one IP within a single window (clock never advanced).
          const req = makeRequest({
            ip: '203.0.113.200',
            principal: makePrincipal({ userId: 'burst-user' }),
          });

          let allowed = 0;
          for (let i = 0; i < burst; i++) {
            const verdict = await gateway.evaluate(req);
            if (verdict.allowed) {
              allowed += 1;
            } else {
              expect(verdict.denialCode).toBe('rate_limited');
              expect(verdict.retryAfterSeconds ?? 0).toBeGreaterThan(0);
            }
          }

          // Never more admitted than the per-IP limit; the rest are rejected.
          expect(allowed).toBe(Math.min(burst, ipLimit));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
