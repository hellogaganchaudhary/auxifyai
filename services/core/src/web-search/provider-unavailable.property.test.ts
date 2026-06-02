/**
 * Feature: auxify-ai-platform, Property 21: Unavailable adapter yields a
 * provider-unavailable error.
 *
 * Validates: Requirements 13.9 (and the configuration-driven selection of
 * Req 13.1 that decides which provider is "the configured provider").
 *
 * Design statement (Property 21): "For any search request issued while the
 * configured Search_Provider_Adapter is unavailable, the Web_Search_Engine
 * returns an error that identifies the search provider as unavailable."
 *
 * "Unavailable" is exercised across every way the configured provider can be
 * unusable, generated arbitrarily alongside an arbitrary search request:
 *
 *   - `reports_unavailable`   — the selected adapter's `isAvailable()` returns
 *                               `false`; the engine must NOT dispatch the search.
 *   - `probe_throws`          — the selected adapter's `isAvailable()` itself
 *                               throws; an availability probe that fails means
 *                               the provider is unusable.
 *   - `search_throws`         — the selected adapter is available but its
 *                               `search()` call fails; reported uniformly as
 *                               provider-unavailable, never leaking internals.
 *   - `not_registered`        — the configured provider id is not in the
 *                               registry; the error identifies that selected id.
 *   - `no_provider_selected`  — configuration names no provider (undefined /
 *                               empty / whitespace) though adapters exist.
 *   - `no_provider_configured`— no adapters are registered at all.
 *
 * For every registered-but-unusable / unknown-selected provider the engine
 * raises {@link ProviderUnavailableError} whose `providerId` equals the
 * CONFIGURED (selected) provider id (Req 13.9); when no provider is
 * configured/selected it raises {@link NoSearchProviderConfiguredError}. In all
 * cases the engine REJECTS — it never returns a (partial/garbage) result array —
 * and each error projects via `toPlatformError(corr)` into a serializable
 * `provider_unavailable` {@link import('@auxify/types').PlatformError} that is
 * retriable, carries the given correlationId, and exposes only secret-free
 * structured details (exactly `{ providerId }`, or none) — never the underlying
 * cause text or any credential.
 *
 * The property drives the REAL {@link WebSearchEngine} against deterministic
 * in-memory adapters (the shared {@link FakeSearchProviderAdapter} plus a tiny
 * self-contained probe-throwing adapter) and an injected provider selector — no
 * real search vendor, network, or timers. A positive control proves the
 * property discriminates: when the configured provider IS available the same
 * engine returns a normal result array rather than throwing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Principal } from '@auxify/types';

import { NoSearchProviderConfiguredError, ProviderUnavailableError } from './errors.js';
import { FakeSearchProviderAdapter, makeWebSearchResult } from './fakes.js';
import {
  SEARCH_TYPES,
  TIME_RANGES,
  type SearchProviderAdapter,
  type SearchType,
  type WebSearchRequest,
  type WebSearchResult,
} from './types.js';
import { WebSearchEngine } from './web-search-engine.js';

/** At least 100 generated iterations, per the spec's PBT minimum. */
const NUM_RUNS = 200;

/** A representative principal; the engine reserves it for future attribution. */
const principal: Principal = {
  userId: 'user-1',
  organizationId: 'org-1',
  roles: ['standard_user'],
  teamIds: [],
  projectIds: [],
  allowedModels: [],
  premiumAuthorized: false,
};

// ---------------------------------------------------------------------------
// A self-contained adapter whose availability probe throws.
// ---------------------------------------------------------------------------

/**
 * A {@link SearchProviderAdapter} whose `isAvailable()` rejects, modelling a
 * health/availability probe that itself fails (e.g. the provider's status
 * endpoint times out). The engine must treat this as provider-unavailable and
 * must never reach `search()`.
 */
class ProbeThrowingAdapter implements SearchProviderAdapter {
  readonly providerId: string;
  /** Set true iff the engine ever dispatched the actual search. */
  searchInvoked = false;
  private readonly error: Error;

  constructor(providerId: string, error: Error) {
    this.providerId = providerId;
    this.error = error;
  }

  async isAvailable(): Promise<boolean> {
    throw this.error;
  }

  async search(): Promise<WebSearchResult[]> {
    this.searchInvoked = true;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** The ways the configured provider can be unusable. */
type FailureMode =
  | 'reports_unavailable'
  | 'probe_throws'
  | 'search_throws'
  | 'not_registered'
  | 'no_provider_selected'
  | 'no_provider_configured';

const FAILURE_MODES: readonly FailureMode[] = [
  'reports_unavailable',
  'probe_throws',
  'search_throws',
  'not_registered',
  'no_provider_selected',
  'no_provider_configured',
] as const;

/** A non-empty provider id that does not collapse to whitespace. */
const providerIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/** A small pool of domains; immaterial to the failure path but exercises the request shape. */
const domainArb: fc.Arbitrary<string> = fc.constantFrom(
  'example.com',
  'news.test',
  'spam.test',
  'docs.org',
);

/** An arbitrary, fully-shaped search request (Req 13.4-13.6). */
const requestArb: fc.Arbitrary<WebSearchRequest> = fc.record({
  query: fc.string(),
  searchType: fc.option(fc.constantFrom(...SEARCH_TYPES), { nil: undefined }),
  timeRange: fc.option(fc.constantFrom(...TIME_RANGES), { nil: undefined }),
  includeDomains: fc.option(fc.array(domainArb, { maxLength: 3 }), { nil: undefined }),
  excludeDomains: fc.option(fc.array(domainArb, { maxLength: 3 }), { nil: undefined }),
  maxResults: fc.option(fc.integer({ min: 1, max: 50 }), { nil: undefined }),
});

/** The "no provider selected" configuration values that mean the same thing. */
const emptySelectionArb: fc.Arbitrary<string | undefined> = fc.constantFrom(
  undefined,
  '',
  '   ',
);

/** A recognizable sentinel embedded in thrown causes; it must NOT leak into structured details. */
const secretArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => `sk-live-secret-${s}`);

/** A correlation id for projecting the typed error onto the wire shape (Req 46.7). */
const correlationIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 16 });

/** One complete unavailability scenario. */
interface Scenario {
  registeredId: string;
  ghostId: string;
  mode: FailureMode;
  request: WebSearchRequest;
  emptySelection: string | undefined;
  secret: string;
  correlationId: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    registeredId: providerIdArb,
    ghostId: providerIdArb,
    mode: fc.constantFrom<FailureMode>(...FAILURE_MODES),
    request: requestArb,
    emptySelection: emptySelectionArb,
    secret: secretArb,
    correlationId: correlationIdArb,
  })
  // `not_registered` requires the selected (ghost) id to differ EXACTLY from the
  // registered id; the engine's registry is keyed by the raw provider id.
  .filter((s) => s.registeredId !== s.ghostId);

// ---------------------------------------------------------------------------
// Scenario assembly: build the REAL engine for a generated failure mode.
// ---------------------------------------------------------------------------

interface BuiltScenario {
  engine: WebSearchEngine;
  /** Asserts the configured provider's `search()` was never dispatched (when applicable). */
  assertSearchNotDispatched: () => void;
  /** Discriminator for the expected typed error and the expected `providerId`. */
  expectation:
    | { kind: 'provider-unavailable'; providerId: string }
    | { kind: 'no-provider' };
}

function buildScenario(s: Scenario): BuiltScenario {
  switch (s.mode) {
    case 'reports_unavailable': {
      const adapter = new FakeSearchProviderAdapter({
        providerId: s.registeredId,
        available: false,
        results: [makeWebSearchResult('https://should-not-appear.test/a', { score: 0.9 })],
      });
      return {
        engine: new WebSearchEngine({ adapters: [adapter], selectProvider: () => s.registeredId }),
        assertSearchNotDispatched: () => expect(adapter.requests).toHaveLength(0),
        expectation: { kind: 'provider-unavailable', providerId: s.registeredId },
      };
    }
    case 'probe_throws': {
      const adapter = new ProbeThrowingAdapter(
        s.registeredId,
        new Error(`availability probe failed ${s.secret}`),
      );
      return {
        engine: new WebSearchEngine({ adapters: [adapter], selectProvider: () => s.registeredId }),
        assertSearchNotDispatched: () => expect(adapter.searchInvoked).toBe(false),
        expectation: { kind: 'provider-unavailable', providerId: s.registeredId },
      };
    }
    case 'search_throws': {
      const adapter = new FakeSearchProviderAdapter({
        providerId: s.registeredId,
        available: true,
        throwOnSearch: new Error(`upstream call failed ${s.secret}`),
      });
      return {
        engine: new WebSearchEngine({ adapters: [adapter], selectProvider: () => s.registeredId }),
        // Here the search WAS dispatched (and then failed): assert it was reached.
        assertSearchNotDispatched: () => expect(adapter.requests).toHaveLength(1),
        expectation: { kind: 'provider-unavailable', providerId: s.registeredId },
      };
    }
    case 'not_registered': {
      const adapter = new FakeSearchProviderAdapter({
        providerId: s.registeredId,
        available: true,
        results: [makeWebSearchResult('https://should-not-appear.test/b', { score: 0.9 })],
      });
      return {
        // A provider is registered, but configuration names a different (ghost) id.
        engine: new WebSearchEngine({ adapters: [adapter], selectProvider: () => s.ghostId }),
        assertSearchNotDispatched: () => expect(adapter.requests).toHaveLength(0),
        // The error identifies the CONFIGURED (selected) id, not the registered one.
        expectation: { kind: 'provider-unavailable', providerId: s.ghostId },
      };
    }
    case 'no_provider_selected': {
      const adapter = new FakeSearchProviderAdapter({
        providerId: s.registeredId,
        available: true,
        results: [makeWebSearchResult('https://should-not-appear.test/c', { score: 0.9 })],
      });
      return {
        engine: new WebSearchEngine({
          adapters: [adapter],
          selectProvider: () => s.emptySelection,
        }),
        assertSearchNotDispatched: () => expect(adapter.requests).toHaveLength(0),
        expectation: { kind: 'no-provider' },
      };
    }
    case 'no_provider_configured': {
      return {
        // No adapters at all; the selector value is irrelevant.
        engine: new WebSearchEngine({ adapters: [], selectProvider: () => s.registeredId }),
        assertSearchNotDispatched: () => undefined,
        expectation: { kind: 'no-provider' },
      };
    }
  }
}

/** Run a search, capturing whether it resolved (with a value) or rejected (with an error). */
async function runSearch(
  engine: WebSearchEngine,
  request: WebSearchRequest,
): Promise<{ ok: true; value: WebSearchResult[] } | { ok: false; error: unknown }> {
  return engine.search(request, principal).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------
// Property.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 21: Unavailable adapter yields a provider-unavailable error', () => {
  it('rejects every search through an unusable/unconfigured provider with the right typed error and a secret-free provider_unavailable projection — never a result array (Validates: Requirements 13.9)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { engine, assertSearchNotDispatched, expectation } = buildScenario(scenario);

        const outcome = await runSearch(engine, scenario.request);

        // The engine NEVER returns a (partial/garbage) result array on these paths.
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return; // unreachable past the assertion above; narrows the union for TS
        }

        // The configured provider's search is not dispatched (except `search_throws`,
        // where the assertion confirms the call was reached and then failed).
        assertSearchNotDispatched();

        const platform =
          expectation.kind === 'provider-unavailable'
            ? assertProviderUnavailable(outcome.error, expectation.providerId)
            : assertNoProviderConfigured(outcome.error);

        // Uniform wire projection (Req 13.9, 46.8): retriable provider outage,
        // tied to the caller's correlation id.
        const projected = platform.toPlatformError(scenario.correlationId);
        expect(projected.category).toBe('provider_unavailable');
        expect(projected.retriable).toBe(true);
        expect(projected.correlationId).toBe(scenario.correlationId);

        // Secret-free structured details: either exactly the configured providerId
        // (and nothing derived from the thrown cause / no credential), or none.
        if (expectation.kind === 'provider-unavailable') {
          expect(projected.details).toEqual({ providerId: expectation.providerId });
        } else {
          expect(projected.details).toBeUndefined();
        }
        // Defensively confirm the injected cause secret never reaches the details.
        expect(JSON.stringify(projected.details ?? null)).not.toContain(scenario.secret);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('control: when the configured provider IS available the same engine returns a normal result array rather than throwing (Validates: Requirements 13.9)', async () => {
    const controlArb = fc.record({
      providerId: providerIdArb,
      query: fc.string(),
      searchType: fc.constantFrom<SearchType>(...SEARCH_TYPES),
      maxResults: fc.integer({ min: 1, max: 20 }),
    });

    await fc.assert(
      fc.asyncProperty(controlArb, async ({ providerId, query, searchType, maxResults }) => {
        const adapter = new FakeSearchProviderAdapter({
          providerId,
          available: true,
          results: (req) => [
            makeWebSearchResult('https://ok.test/a', { score: 0.9, searchType: req.searchType }),
            makeWebSearchResult('https://ok.test/b', { score: 0.4, searchType: req.searchType }),
          ],
        });
        const engine = new WebSearchEngine({
          adapters: [adapter],
          selectProvider: () => providerId,
        });

        // `timeRange: 'all'` with no domain filters keeps the seeded results so the
        // control proves a successful, non-throwing return path.
        const results = await engine.search(
          { query, searchType, timeRange: 'all', maxResults },
          principal,
        );

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        expect(adapter.requests).toHaveLength(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Typed-error assertions (narrow `unknown` while asserting the exact type).
// ---------------------------------------------------------------------------

function assertProviderUnavailable(
  error: unknown,
  expectedProviderId: string,
): ProviderUnavailableError {
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  const typed = error as ProviderUnavailableError;
  // The error identifies the configured (selected) provider as unavailable (Req 13.9).
  expect(typed.providerId).toBe(expectedProviderId);
  return typed;
}

function assertNoProviderConfigured(error: unknown): NoSearchProviderConfiguredError {
  expect(error).toBeInstanceOf(NoSearchProviderConfiguredError);
  return error as NoSearchProviderConfiguredError;
}
