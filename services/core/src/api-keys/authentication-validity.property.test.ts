/**
 * Property-based test for **Property 40: API key authentication is valid only
 * while active, unexpired, and not revoked** (design "Property 40";
 * Req 21.3, 21.4, 21.5).
 *
 * **Validates: Requirements 21.3, 21.4, 21.5**
 *
 * Property 40 (design): _For any_ presented API key, authentication succeeds if
 * and only if the key is active, its expiration is in the future, and it has not
 * been revoked; revocation and expiration take effect immediately on subsequent
 * authentication attempts. Requirement 21.3 authenticates a presented key only
 * if it is active and unexpired; Requirement 21.4 treats a key past its
 * expiration as invalid; Requirement 21.5 rejects a revoked key on the very next
 * request that presents it.
 *
 * This file is deliberately self-contained: it drives the real
 * {@link ApiKeyManager} (task 19.1) through arbitrary key lifecycles — create,
 * then revoke / let expire (by advancing an injected, mutable clock) / rotate,
 * plus seeded inactive keys — and presents either a genuine key or a fabricated
 * "wrong" key. It cross-checks every verdict against an INDEPENDENT oracle that
 * is computed from the lifecycle facts the test itself produced (not by reading
 * the store's internals): a presented key authenticates _iff_ it equals a stored
 * key that is currently active, not revoked, and not past expiry; otherwise the
 * verdict is `authenticated: false` with the matching reason
 * (`unknown` / `revoked` / `inactive` / `expired`). A wrong/unknown key — even
 * one sharing a real key's visible prefix — always returns reason `unknown`,
 * never revealing whether a similar key exists.
 *
 * The fakes (an in-memory tenant-scoped store, a deterministic RNG and id
 * generator, a tenant builder) are imported directly from `./fakes.js`, matching
 * the module convention. A local {@link MutableClock} provides the injectable,
 * advanceable time source the expiry assertions need; the production
 * {@link sha256KeyHasher} is used so `findByHash` resolves on the real digest.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ApiKeyManager } from './api-key-manager.js';
import {
  CapturingAuditRecorder,
  InMemoryApiKeyStore,
  SequentialRandomSource,
  makeTenant,
  sequentialKeyIdGenerator,
} from './fakes.js';
import { extractPrefix, sha256KeyHasher } from './key-crypto.js';
import { DEFAULT_RATE_LIMIT, type KeyAuthFailureReason } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** The clock's fixed origin for every scenario. */
const CLOCK_ORIGIN = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// A mutable, injectable clock (the manager takes `now: () => Date`)
// ---------------------------------------------------------------------------

/**
 * A deterministic clock whose instant can be advanced, so the test can model
 * the passage of time that makes a key cross its expiry (Req 21.4). The bound
 * {@link now} closure is what the {@link ApiKeyManager} reads on every
 * timestamp, expiry check, and rate-limit window.
 */
class MutableClock {
  private currentMs: number;

  constructor(startIso: string = CLOCK_ORIGIN) {
    this.currentMs = new Date(startIso).getTime();
  }

  /** The bound time source handed to the manager. */
  readonly now = (): Date => new Date(this.currentMs);

  /** Advance the clock forward by the given number of seconds. */
  advanceSeconds(seconds: number): void {
    this.currentMs += seconds * 1000;
  }
}

// ---------------------------------------------------------------------------
// Independent lifecycle model + oracle
// ---------------------------------------------------------------------------

/** The test's own record of a key's lifecycle facts, keyed by its plaintext. */
interface ModelKey {
  plaintext: string;
  id: string;
  organizationId: string;
  ownerId: string;
  /** Currently enabled (Req 21.3). */
  active: boolean;
  /** Has been revoked (Req 21.5). */
  revoked: boolean;
  /** Expiry instant in epoch-ms, or `null` when the key never expires (Req 21.4). */
  expiresAtMs: number | null;
}

/** The verdict the oracle predicts for a presentation. */
type ExpectedVerdict =
  | { authenticated: true; id: string; organizationId: string; ownerId: string }
  | { authenticated: false; reason: KeyAuthFailureReason };

/**
 * The INDEPENDENT oracle: from the lifecycle facts alone, predict the verdict.
 * The check order mirrors the acceptance criteria's precedence — a missing key
 * is `unknown`, then revocation (Req 21.5), then inactivity (Req 21.3), then
 * expiry (Req 21.4); only a known, active, unrevoked, unexpired key authenticates.
 */
function predict(model: ModelKey | undefined, nowMs: number): ExpectedVerdict {
  if (model === undefined) return { authenticated: false, reason: 'unknown' };
  if (model.revoked) return { authenticated: false, reason: 'revoked' };
  if (!model.active) return { authenticated: false, reason: 'inactive' };
  if (model.expiresAtMs !== null && model.expiresAtMs <= nowMs) {
    return { authenticated: false, reason: 'expired' };
  }
  return {
    authenticated: true,
    id: model.id,
    organizationId: model.organizationId,
    ownerId: model.ownerId,
  };
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

/** How a single key is set up within a scenario. */
type KeySpec =
  | { kind: 'active' | 'revoked' | 'rotated'; expiryOffsetSec: number | null }
  | { kind: 'inactive' };

/** An optional positive expiry offset (seconds from the clock origin), or none. */
const expiryOffsetArb: fc.Arbitrary<number | null> = fc.option(
  fc.integer({ min: 1, max: 1_000_000 }),
  { nil: null },
);

/**
 * One key set-up: a key that is left active, revoked, or rotated away (each
 * optionally carrying an expiry), or a directly-seeded inactive key (active
 * `false`, never revoked — the one path that yields reason `inactive`).
 */
const keySpecArb: fc.Arbitrary<KeySpec> = fc.oneof(
  fc
    .record({
      kind: fc.constantFrom<'active' | 'revoked' | 'rotated'>('active', 'revoked', 'rotated'),
      expiryOffsetSec: expiryOffsetArb,
    })
    .map((r): KeySpec => r),
  fc.constant<KeySpec>({ kind: 'inactive' }),
);

/** Construct a manager wired with deterministic fakes and a mutable clock. */
function makeManager(clock: MutableClock): { manager: ApiKeyManager; store: InMemoryApiKeyStore } {
  const store = new InMemoryApiKeyStore();
  const manager = new ApiKeyManager({
    store,
    audit: new CapturingAuditRecorder(),
    random: new SequentialRandomSource(),
    hasher: sha256KeyHasher,
    idGenerator: sequentialKeyIdGenerator(),
    now: clock.now,
  });
  return { manager, store };
}

/**
 * Execute a list of key set-ups against a fresh manager, advance the clock, and
 * return both the manager and the independent lifecycle model. All keys are
 * created at the clock origin (so expiries validate as future-dated), mutated,
 * and only then is the clock advanced — so expiry is evaluated at authentication
 * time, exactly as the manager does.
 */
async function buildScenario(
  specs: readonly KeySpec[],
  advanceSec: number,
): Promise<{ manager: ApiKeyManager; model: Map<string, ModelKey>; clock: MutableClock }> {
  const clock = new MutableClock();
  const { manager, store } = makeManager(clock);
  const startMs = clock.now().getTime();
  const model = new Map<string, ModelKey>();
  let n = 0;

  for (const spec of specs) {
    n += 1;
    const ctx = makeTenant({ organizationId: `org-${n}`, userId: `user-${n}` });

    if (spec.kind === 'inactive') {
      // A key the store holds with active=false and no revocation — distinct
      // from a revoked key, so it must surface reason `inactive` (Req 21.3).
      const plaintext = `axk_seeded_inactive_${n}`;
      const id = `seed-${n}`;
      store.seed({
        id,
        organizationId: ctx.organizationId,
        ownerId: ctx.userId,
        name: '',
        prefix: extractPrefix(plaintext),
        hash: sha256KeyHasher.hash(plaintext),
        active: false,
        rateLimit: DEFAULT_RATE_LIMIT,
        createdAt: clock.now().toISOString(),
      });
      model.set(plaintext, {
        plaintext,
        id,
        organizationId: ctx.organizationId,
        ownerId: ctx.userId,
        active: false,
        revoked: false,
        expiresAtMs: null,
      });
      continue;
    }

    const expiresAtMs =
      spec.expiryOffsetSec === null ? null : startMs + spec.expiryOffsetSec * 1000;
    const created = await manager.create(
      ctx,
      expiresAtMs === null ? {} : { expiresAt: new Date(expiresAtMs).toISOString() },
    );
    model.set(created.plaintext, {
      plaintext: created.plaintext,
      id: created.key.id,
      organizationId: ctx.organizationId,
      ownerId: ctx.userId,
      active: true,
      revoked: false,
      expiresAtMs,
    });

    if (spec.kind === 'revoked') {
      await manager.revoke(ctx, created.key.id);
      const m = model.get(created.plaintext)!;
      m.active = false;
      m.revoked = true;
    } else if (spec.kind === 'rotated') {
      // Rotation mints a replacement and invalidates the old key (Req 21.6):
      // the old key becomes revoked; the new key inherits owner/expiry.
      const rotated = await manager.rotate(ctx, created.key.id);
      const old = model.get(created.plaintext)!;
      old.active = false;
      old.revoked = true;
      model.set(rotated.plaintext, {
        plaintext: rotated.plaintext,
        id: rotated.key.id,
        organizationId: ctx.organizationId,
        ownerId: ctx.userId,
        active: true,
        revoked: false,
        expiresAtMs,
      });
    }
  }

  clock.advanceSeconds(advanceSec);
  return { manager, model, clock };
}

// ---------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 40: API key authentication is valid only while active, unexpired, and not revoked', () => {
  it('authenticate/verify accept a presented key iff it is known, active, not revoked, and unexpired — with the matching reason otherwise (Validates: Requirements 21.3, 21.4, 21.5)', async () => {
    const scenarioArb = fc.record({
      specs: fc.array(keySpecArb, { minLength: 1, maxLength: 4 }),
      advanceSec: fc.integer({ min: 0, max: 2_000_000 }),
      pickRaw: fc.nat(),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ specs, advanceSec, pickRaw }) => {
        const { manager, model, clock } = await buildScenario(specs, advanceSec);

        // Present a genuine key drawn from the keys this scenario produced.
        const plaintexts = [...model.keys()];
        const presented = plaintexts[pickRaw % plaintexts.length]!;
        const oracle = predict(model.get(presented), clock.now().getTime());

        const result = await manager.authenticate(presented);

        if (oracle.authenticated) {
          // Accepted exactly when active, unrevoked, and unexpired — and it
          // resolves the right principal (org/owner) and key id.
          expect(result.authenticated).toBe(true);
          if (result.authenticated) {
            expect(result.key.id).toBe(oracle.id);
            expect(result.key.organizationId).toBe(oracle.organizationId);
            expect(result.key.ownerId).toBe(oracle.ownerId);
            // A successful verdict never carries a failure reason.
            expect((result as unknown as Record<string, unknown>).reason).toBeUndefined();
          }
        } else {
          // Rejected with precisely the reason the lifecycle dictates.
          expect(result).toEqual({ authenticated: false, reason: oracle.reason });
        }

        // verify() is an alias of authenticate(): same verdict for the same key.
        expect(await manager.verify(presented)).toEqual(result);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a wrong/unknown key as reason 'unknown' without revealing whether a similar key exists (Validates: Requirements 21.3)", async () => {
    const wrongArb = fc.record({
      specs: fc.array(keySpecArb, { minLength: 1, maxLength: 5 }),
      advanceSec: fc.integer({ min: 0, max: 2_000_000 }),
      pickRaw: fc.nat(),
      suffix: fc.string({ minLength: 1, maxLength: 8 }),
      // 'append' keeps a real key's visible prefix (a near-miss); 'fresh' is
      // unrelated. Both must be indistinguishable — always reason 'unknown'.
      mode: fc.constantFrom<'append' | 'fresh'>('append', 'fresh'),
    });

    await fc.assert(
      fc.asyncProperty(wrongArb, async ({ specs, advanceSec, pickRaw, suffix, mode }) => {
        const { manager, model } = await buildScenario(specs, advanceSec);

        const plaintexts = [...model.keys()];
        const base = plaintexts[pickRaw % plaintexts.length]!;
        const presented =
          mode === 'append' ? `${base}~${suffix}` : `axk_wrong_${suffix}_${pickRaw}`;

        // Only meaningful when the presented value is genuinely not a real key.
        fc.pre(!model.has(presented));

        const result = await manager.authenticate(presented);

        // Always 'unknown' — never 'revoked'/'inactive'/'expired'/true — so the
        // verdict leaks nothing about the existence or state of similar keys,
        // even when `presented` shares a real, active key's prefix.
        expect(result).toEqual({ authenticated: false, reason: 'unknown' });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('applies revocation and expiration immediately on the next authentication (Validates: Requirements 21.4, 21.5)', async () => {
    const immediacyArb = fc.record({
      transition: fc.constantFrom<'revoke' | 'expire'>('revoke', 'expire'),
      expiryOffsetSec: fc.integer({ min: 1, max: 1_000_000 }),
      extraAdvanceSec: fc.integer({ min: 0, max: 1000 }),
    });

    await fc.assert(
      fc.asyncProperty(
        immediacyArb,
        async ({ transition, expiryOffsetSec, extraAdvanceSec }) => {
          const clock = new MutableClock();
          const { manager } = makeManager(clock);
          const ctx = makeTenant();
          const startMs = clock.now().getTime();

          if (transition === 'revoke') {
            const created = await manager.create(ctx);
            // Valid before the transition...
            expect((await manager.authenticate(created.plaintext)).authenticated).toBe(true);
            await manager.revoke(ctx, created.key.id);
            // ...immediately rejected on the very next attempt (Req 21.5).
            expect(await manager.authenticate(created.plaintext)).toEqual({
              authenticated: false,
              reason: 'revoked',
            });
          } else {
            const expiresAtMs = startMs + expiryOffsetSec * 1000;
            const created = await manager.create(ctx, {
              expiresAt: new Date(expiresAtMs).toISOString(),
            });
            // Valid while the expiry is still in the future...
            expect((await manager.authenticate(created.plaintext)).authenticated).toBe(true);
            // ...invalid the moment the clock reaches/passes expiry (Req 21.4).
            clock.advanceSeconds(expiryOffsetSec + extraAdvanceSec);
            expect(await manager.authenticate(created.plaintext)).toEqual({
              authenticated: false,
              reason: 'expired',
            });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
