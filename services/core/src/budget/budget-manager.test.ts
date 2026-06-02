/**
 * Unit tests for the Budget_Manager (Req 22.1-22.6).
 *
 * Exercises the full public surface against the deterministic in-memory fakes
 * (a hand-advanced clock, in-memory budget/usage stores, a capturing audit
 * recorder, and a recording alert notifier) imported directly from `./fakes.js`:
 *
 *  - set + get a validated budget, rejecting an invalid configuration (Req 22.2-22.5);
 *  - recordUsage accumulating consumed spend and `remaining = limit - consumed`;
 *  - the threshold-warning and at/over-cap status transitions (Req 22.2-22.4);
 *  - the period reset across a period boundary via the injectable clock (Req 22.3-22.5);
 *  - the enforce() decisions — user-cap block (Req 22.3), team-cap
 *    restrict-to-economy (Req 22.4), per-model daily limit reject (Req 22.5);
 *  - cost attribution reconciling across the tenant hierarchy (Req 22.1, Property 42);
 *  - scope/tenant isolation between Organizations (Req 1.4);
 *  - audit recording on set and on threshold/cap crossings, plus out-of-band
 *    administrator notification (Req 22.2, 37.2).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { BudgetManager, validateBudgetConfig } from './budget-manager.js';
import { InvalidBudgetConfigError } from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryBudgetStore,
  InMemoryUsageStore,
  MutableBudgetClock,
  RecordingAlertNotifier,
  sequentialBudgetIdGenerator,
} from './fakes.js';
import { organizationScope, projectScope, teamScope, userScope } from './types.js';
import type { BudgetConfig } from './types.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** A fixed mid-month instant so day/month period windows are unambiguous. */
const NOW_ISO = '2026-06-15T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  manager: BudgetManager;
  budgets: InMemoryBudgetStore;
  usage: InMemoryUsageStore;
  audit: CapturingAuditRecorder;
  notifier: RecordingAlertNotifier;
  clock: MutableBudgetClock;
}

/** Construct a BudgetManager wired with deterministic in-memory fakes. */
function makeManager(): Harness {
  const budgets = new InMemoryBudgetStore();
  const usage = new InMemoryUsageStore();
  const audit = new CapturingAuditRecorder();
  const notifier = new RecordingAlertNotifier();
  const clock = new MutableBudgetClock(Date.parse(NOW_ISO));
  const manager = new BudgetManager({
    budgets,
    usage,
    audit,
    notifier,
    clock,
    idGenerator: sequentialBudgetIdGenerator(),
  });
  return { manager, budgets, usage, audit, notifier, clock };
}

/** A tenant context with overridable scope. */
function makeTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return { organizationId: 'org-1', userId: 'user-1', ...overrides };
}

/** A baseline valid month budget. */
function monthBudget(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return { limit: 100, alertThreshold: 0.8, period: 'month', ...overrides };
}

// ---------------------------------------------------------------------------
// setBudget / getBudget + validation (Req 22.2-22.5)
// ---------------------------------------------------------------------------

describe('BudgetManager.setBudget / getBudget (Req 22.2-22.5)', () => {
  it('persists a budget and reads it back for the scope', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');

    const record = await manager.setBudget(ctx, scope, monthBudget({ limit: 250 }));

    expect(record.limit).toBe(250);
    expect(record.level).toBe('user');
    expect(record.refId).toBe('user-1');

    const fetched = await manager.getBudget(scope);
    expect(fetched).not.toBeNull();
    expect(fetched?.limit).toBe(250);
    expect(fetched?.alertThreshold).toBe(0.8);
    expect(fetched?.period).toBe('month');
  });

  it('returns null when no budget is configured for a scope', async () => {
    const { manager } = makeManager();
    expect(await manager.getBudget(userScope('org-1', 'nobody'))).toBeNull();
  });

  it('preserves createdAt while advancing updatedAt on replace', async () => {
    const { manager, clock } = makeManager();
    const ctx = makeTenant();
    const scope = teamScope('org-1', 'team-1');

    const first = await manager.setBudget(ctx, scope, monthBudget({ limit: 100 }));
    clock.advance(DAY_MS);
    const second = await manager.setBudget(ctx, scope, monthBudget({ limit: 200 }));

    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    expect(second.limit).toBe(200);
  });

  it('rejects a negative cap, an out-of-range alert fraction, and a non-positive per-model limit', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');

    await expect(manager.setBudget(ctx, scope, monthBudget({ limit: -1 }))).rejects.toBeInstanceOf(
      InvalidBudgetConfigError,
    );
    await expect(
      manager.setBudget(ctx, scope, monthBudget({ alertThreshold: 0 })),
    ).rejects.toBeInstanceOf(InvalidBudgetConfigError);
    await expect(
      manager.setBudget(ctx, scope, monthBudget({ alertThreshold: 1.5 })),
    ).rejects.toBeInstanceOf(InvalidBudgetConfigError);
    await expect(
      manager.setBudget(ctx, scope, monthBudget({ perModelDailyMessageLimits: { 'gpt-x': 0 } })),
    ).rejects.toBeInstanceOf(InvalidBudgetConfigError);
  });

  it('rejects a scope that belongs to a different Organization (Req 1.4)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant({ organizationId: 'org-1' });
    const foreignScope = userScope('org-2', 'user-1');

    await expect(manager.setBudget(ctx, foreignScope, monthBudget())).rejects.toBeInstanceOf(
      InvalidBudgetConfigError,
    );
  });

  it('validateBudgetConfig accepts a well-formed configuration', () => {
    expect(() =>
      validateBudgetConfig({
        limit: 10,
        alertThreshold: 1,
        period: 'day',
        perModelDailyMessageLimits: { 'gpt-4': 5 },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordUsage + consumed + remaining (Req 22.1)
// ---------------------------------------------------------------------------

describe('BudgetManager.recordUsage / consumed / remaining (Req 22.1)', () => {
  it('accumulates consumed spend across records in the active period', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');

    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 5 });
    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 7.5 });

    expect(await manager.consumed(scope)).toBeCloseTo(12.5, 10);
  });

  it('appends an immutable usage record with the supplied attribution and cost', async () => {
    const { manager, usage } = makeManager();
    const ctx = makeTenant({ teamId: 'team-1', projectId: 'proj-1' });

    const { record } = await manager.recordUsage(ctx, {
      model: 'gpt-4',
      provider: 'openai',
      cost: 3,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(record.organizationId).toBe('org-1');
    expect(record.teamId).toBe('team-1');
    expect(record.projectId).toBe('proj-1');
    expect(record.userId).toBe('user-1');
    expect(record.cost).toBe(3);
    expect(usage.records).toHaveLength(1);
  });

  it('reports remaining as limit - consumed via evaluate', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');
    await manager.setBudget(ctx, scope, monthBudget({ limit: 100 }));

    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 30 });

    const evaluation = await manager.evaluate(scope);
    expect(evaluation.limit).toBe(100);
    expect(evaluation.consumed).toBe(30);
    expect(evaluation.remaining).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// evaluate status transitions (Req 22.2, 22.3, 22.4)
// ---------------------------------------------------------------------------

describe('BudgetManager.evaluate status (Req 22.2-22.4)', () => {
  it('is no_budget with null amounts when no budget is configured', async () => {
    const { manager } = makeManager();
    const evaluation = await manager.evaluate(userScope('org-1', 'user-1'));

    expect(evaluation.status).toBe('no_budget');
    expect(evaluation.limit).toBeNull();
    expect(evaluation.remaining).toBeNull();
    expect(evaluation.alertThreshold).toBeNull();
  });

  it('is under below the alert threshold', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');
    await manager.setBudget(ctx, scope, monthBudget({ limit: 100, alertThreshold: 0.8 }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 50 });

    expect((await manager.evaluate(scope)).status).toBe('under');
  });

  it('is threshold_warning at the alert fraction but below the cap (Req 22.2)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');
    await manager.setBudget(ctx, scope, monthBudget({ limit: 100, alertThreshold: 0.8 }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 85 });

    const evaluation = await manager.evaluate(scope);
    expect(evaluation.status).toBe('threshold_warning');
    expect(evaluation.thresholdAmount).toBe(80);
    expect(evaluation.remaining).toBe(15);
  });

  it('is at_or_over_cap once spend reaches or exceeds the cap (Req 22.3, 22.4)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');
    await manager.setBudget(ctx, scope, monthBudget({ limit: 100 }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 105 });

    const evaluation = await manager.evaluate(scope);
    expect(evaluation.status).toBe('at_or_over_cap');
    expect(evaluation.remaining).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// period reset via the injectable clock (Req 22.3-22.5)
// ---------------------------------------------------------------------------

describe('BudgetManager period reset (Req 22.3-22.5)', () => {
  it('resets consumed spend to zero once the clock advances past the period boundary', async () => {
    const { manager, clock } = makeManager();
    const ctx = makeTenant();
    const scope = userScope('org-1', 'user-1');
    await manager.setBudget(ctx, scope, monthBudget({ limit: 100, period: 'month' }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 30 });
    expect(await manager.consumed(scope)).toBe(30);

    // Advance from 2026-06-15 into the next calendar month.
    clock.advance(31 * DAY_MS);
    expect(await manager.consumed(scope)).toBe(0);
    expect((await manager.evaluate(scope)).status).toBe('under');
  });

  it('retains the usage history across a reset (Req 22.6)', async () => {
    const { manager, usage, clock } = makeManager();
    const ctx = makeTenant();
    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 30 });

    clock.advance(31 * DAY_MS);

    expect(usage.records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// enforce decisions (Req 22.3, 22.4, 22.5)
// ---------------------------------------------------------------------------

describe('BudgetManager.enforce (Req 22.3, 22.4, 22.5)', () => {
  it('allows a request when no cap blocks it', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();

    const decision = await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' });
    expect(decision.allowed).toBe(true);
    expect(decision.kind).toBe('allow');
  });

  it('blocks a user who has reached the user-level cap (Req 22.3)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setBudget(ctx, userScope('org-1', 'user-1'), monthBudget({ limit: 10 }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 10 });

    const decision = await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' });
    expect(decision.allowed).toBe(false);
    expect(decision.kind).toBe('block_user_cap');
    expect(decision.scope?.level).toBe('user');
  });

  it('restricts a team at the team cap to Economy models (Req 22.4)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant({ teamId: 'team-1' });
    await manager.setBudget(ctx, teamScope('org-1', 'team-1'), monthBudget({ limit: 10 }));

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 10 });

    const blocked = await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.kind).toBe('restrict_to_economy');
    expect(blocked.scope?.level).toBe('team');

    const allowed = await manager.enforce(ctx, { modelId: 'cheap', modelTier: 'economy' });
    expect(allowed.allowed).toBe(true);
    expect(allowed.kind).toBe('allow');
  });

  it('rejects a model that exceeded its per-model daily message limit (Req 22.5)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setBudget(
      ctx,
      userScope('org-1', 'user-1'),
      monthBudget({ limit: 10_000, perModelDailyMessageLimits: { 'gpt-4': 2 } }),
    );

    // Two messages to gpt-4 reach the daily limit (low cost so the cap is not hit first).
    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 1 });
    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 1 });

    const decision = await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' });
    expect(decision.allowed).toBe(false);
    expect(decision.kind).toBe('reject_model_daily_limit');

    // A different model is unaffected by gpt-4's daily limit.
    const other = await manager.enforce(ctx, { modelId: 'claude', modelTier: 'standard' });
    expect(other.allowed).toBe(true);
  });

  it('resets the per-model daily limit after the day rolls over (Req 22.5)', async () => {
    const { manager, clock } = makeManager();
    const ctx = makeTenant();
    await manager.setBudget(
      ctx,
      userScope('org-1', 'user-1'),
      monthBudget({ limit: 10_000, perModelDailyMessageLimits: { 'gpt-4': 1 } }),
    );

    await manager.recordUsage(ctx, { model: 'gpt-4', provider: 'openai', cost: 1 });
    expect((await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' })).allowed).toBe(
      false,
    );

    clock.advance(DAY_MS);
    expect((await manager.enforce(ctx, { modelId: 'gpt-4', modelTier: 'standard' })).allowed).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// hierarchy attribution + reconciliation (Req 22.1, Property 42)
// ---------------------------------------------------------------------------

describe('BudgetManager hierarchy attribution (Req 22.1)', () => {
  it('attributes one request to user, Project, Team, and Organization at once', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant({ teamId: 'team-1', projectId: 'proj-1' });

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 9 });

    expect(await manager.consumed(organizationScope('org-1'))).toBe(9);
    expect(await manager.consumed(teamScope('org-1', 'team-1'))).toBe(9);
    expect(await manager.consumed(projectScope('org-1', 'proj-1'))).toBe(9);
    expect(await manager.consumed(userScope('org-1', 'user-1'))).toBe(9);
  });

  it('reconciles the Organization total as the sum of its users (Property 42)', async () => {
    const { manager } = makeManager();
    const ctxA = makeTenant({ userId: 'user-a', teamId: 'team-1', projectId: 'proj-1' });
    const ctxB = makeTenant({ userId: 'user-b', teamId: 'team-1', projectId: 'proj-1' });

    await manager.recordUsage(ctxA, { model: 'm', provider: 'p', cost: 3 });
    await manager.recordUsage(ctxB, { model: 'm', provider: 'p', cost: 5 });

    const org = await manager.consumed(organizationScope('org-1'));
    const team = await manager.consumed(teamScope('org-1', 'team-1'));
    const project = await manager.consumed(projectScope('org-1', 'proj-1'));
    const userA = await manager.consumed(userScope('org-1', 'user-a'));
    const userB = await manager.consumed(userScope('org-1', 'user-b'));

    expect(org).toBe(8);
    expect(team).toBe(8);
    expect(project).toBe(8);
    expect(userA + userB).toBe(org);
  });
});

// ---------------------------------------------------------------------------
// scope / tenant isolation (Req 1.4)
// ---------------------------------------------------------------------------

describe('BudgetManager tenant isolation (Req 1.4)', () => {
  it('does not share a budget or consumed spend across Organizations with the same refId', async () => {
    const { manager } = makeManager();
    const ctx1 = makeTenant({ organizationId: 'org-1', userId: 'shared-user' });
    const ctx2 = makeTenant({ organizationId: 'org-2', userId: 'shared-user' });

    await manager.setBudget(ctx1, userScope('org-1', 'shared-user'), monthBudget({ limit: 100 }));
    await manager.recordUsage(ctx1, { model: 'm', provider: 'p', cost: 40 });
    await manager.recordUsage(ctx2, { model: 'm', provider: 'p', cost: 5 });

    // org-2 has no budget for the same user id, and only sees its own spend.
    expect(await manager.getBudget(userScope('org-2', 'shared-user'))).toBeNull();
    expect(await manager.consumed(userScope('org-1', 'shared-user'))).toBe(40);
    expect(await manager.consumed(userScope('org-2', 'shared-user'))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// audit recording + alert notification (Req 22.2, 37.2)
// ---------------------------------------------------------------------------

describe('BudgetManager auditing and alerts (Req 22.2, 37.2)', () => {
  it('records a budget.set audit event on set', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant({ organizationId: 'org-7' });

    await manager.setBudget(ctx, userScope('org-7', 'user-1'), monthBudget({ limit: 50 }));

    const events = audit.withAction('budget.set');
    expect(events).toHaveLength(1);
    expect(events[0]?.ctx.organizationId).toBe('org-7');
    expect(events[0]?.event.resourceType).toBe('usage_record');
  });

  it('audits and notifies on a threshold crossing then a cap crossing (Req 22.2)', async () => {
    const { manager, audit, notifier } = makeManager();
    const ctx = makeTenant();
    await manager.setBudget(
      ctx,
      userScope('org-1', 'user-1'),
      monthBudget({ limit: 100, alertThreshold: 0.8 }),
    );

    // 50 -> under (no crossing); +40 -> 90 crosses 80 threshold; +20 -> 110 crosses 100 cap.
    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 50 });
    const noCrossingYet = await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 40 });
    expect(noCrossingYet.alerts.map((a) => a.kind)).toEqual(['threshold_warning']);

    const capCrossing = await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 20 });
    expect(capCrossing.alerts.map((a) => a.kind)).toEqual(['cap_reached']);

    expect(audit.withAction('budget.threshold_warning')).toHaveLength(1);
    expect(audit.withAction('budget.cap_reached')).toHaveLength(1);
    expect(notifier.ofKind('threshold_warning')).toHaveLength(1);
    expect(notifier.ofKind('cap_reached')).toHaveLength(1);
  });

  it('does not re-alert on subsequent records once a boundary is already crossed', async () => {
    const { manager, notifier } = makeManager();
    const ctx = makeTenant();
    await manager.setBudget(
      ctx,
      userScope('org-1', 'user-1'),
      monthBudget({ limit: 100, alertThreshold: 0.8 }),
    );

    await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 120 }); // crosses both at once
    const after = await manager.recordUsage(ctx, { model: 'm', provider: 'p', cost: 10 });

    expect(after.alerts).toHaveLength(0);
    expect(notifier.ofKind('threshold_warning')).toHaveLength(1);
    expect(notifier.ofKind('cap_reached')).toHaveLength(1);
  });
});
