/**
 * Property test for per-scope budget enforcement (Property 43, Req 22.3-22.5).
 *
 * Validates the Budget_Manager's fail-closed {@link BudgetManager.enforce}
 * decision for a billable request against an independent oracle that re-derives
 * the documented precedence straight from the acceptance criteria:
 *
 *   1. the user-level cap blocks every billable request for the user until the
 *      cap resets (Req 22.3 -> `block_user_cap`);
 *   2. otherwise, a per-model daily message limit on the user's budget rejects
 *      that model for the remainder of the day (Req 22.5 ->
 *      `reject_model_daily_limit`);
 *   3. otherwise, the team-level cap restricts the team to Economy models, so a
 *      non-Economy request is refused (Req 22.4 -> `restrict_to_economy`);
 *   4. otherwise the request is allowed.
 *
 * The oracle is deliberately self-contained: it sums each scope's prior spend
 * and counts the model's daily messages from the *generated* scenario rather
 * than calling any production helper, so it detects drift in the gate. Prior
 * spend is created through the real {@link BudgetManager.recordUsage} path
 * against the deterministic in-memory fakes imported directly from `./fakes.js`,
 * and every record is stamped at a single fixed instant so it falls inside the
 * active day/month window of any generated budget (which is what makes a plain
 * per-scope sum a sound oracle). A single usage record can attribute to a
 * different user than team, so user-scope and team-scope spend are varied
 * independently.
 *
 * Each property is checked over >= 100 generated iterations with `fast-check`.
 *
 * This file is intentionally self-contained (task 19.5 concurrently adds a
 * separate property test to the same module): it defines its own harness,
 * generators, and oracle and shares no helpers with sibling test files.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModelTier, TenantContext } from '@auxify/types';

import { BudgetManager } from './budget-manager.js';
import {
  CapturingAuditRecorder,
  InMemoryBudgetStore,
  InMemoryUsageStore,
  MutableBudgetClock,
  sequentialBudgetIdGenerator,
} from './fakes.js';
import { teamScope, userScope } from './types.js';
import type { BillableRequest, BudgetConfig, BudgetDecisionKind } from './types.js';

/** Minimum generated iterations for each property (>= 100). */
const NUM_RUNS = 200;

/** A fixed mid-month, mid-day instant so day/month windows are unambiguous. */
const NOW_ISO = '2026-06-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed identities the scenarios are built around.
const ORG = 'org-1';
const USER = 'user-T';
const TEAM = 'team-T';
const MODEL = 'model-T';

interface Harness {
  manager: BudgetManager;
  budgets: InMemoryBudgetStore;
  usage: InMemoryUsageStore;
  clock: MutableBudgetClock;
}

/** Construct a BudgetManager wired with fresh deterministic in-memory fakes at {@link NOW_MS}. */
function makeHarness(): Harness {
  const budgets = new InMemoryBudgetStore();
  const usage = new InMemoryUsageStore();
  const audit = new CapturingAuditRecorder();
  const clock = new MutableBudgetClock(NOW_MS);
  const manager = new BudgetManager({
    budgets,
    usage,
    audit,
    clock,
    idGenerator: sequentialBudgetIdGenerator(),
  });
  return { manager, budgets, usage, clock };
}

// ---------------------------------------------------------------------------
// Scenario model.
// ---------------------------------------------------------------------------

type Period = 'day' | 'month';

/** A generated user budget, optionally carrying a per-model daily limit. */
interface GenUserBudget {
  limit: number;
  alertThreshold: number;
  period: Period;
  perModelLimit: number | undefined;
}

/** A generated team budget. */
interface GenTeamBudget {
  limit: number;
  alertThreshold: number;
  period: Period;
}

/** One prior billable request, attributed to a (possibly "other") user/team/model. */
interface SpendEntry {
  user: string;
  team: string;
  model: string;
  cost: number;
}

/** A full enforcement scenario. */
interface Scenario {
  userBudget: GenUserBudget | undefined;
  teamBudget: GenTeamBudget | undefined;
  hasTeamCtx: boolean;
  modelTier: ModelTier;
  spend: SpendEntry[];
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A valid alert fraction in `(0, 1]` (irrelevant to enforce, required by setBudget). */
const alertArb = fc.constantFrom(0.1, 0.25, 0.5, 0.8, 1);
/** A valid budget reset cadence. */
const periodArb = fc.constantFrom<Period>('day', 'month');
/** An integer spend cap, including the boundary `0` (a 0-cap is always at/over). */
const limitArb = fc.integer({ min: 0, max: 250 });
/** The tier of the target model. */
const tierArb = fc.constantFrom<ModelTier>('economy', 'standard', 'premium');

/** A generated user budget (or none), optionally carrying a per-model daily limit. */
const userBudgetArb: fc.Arbitrary<GenUserBudget | undefined> = fc.option(
  fc.record({
    limit: limitArb,
    alertThreshold: alertArb,
    period: periodArb,
    perModelLimit: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  }),
  { nil: undefined },
);

/** A generated team budget (or none). */
const teamBudgetArb: fc.Arbitrary<GenTeamBudget | undefined> = fc.option(
  fc.record({ limit: limitArb, alertThreshold: alertArb, period: periodArb }),
  { nil: undefined },
);

/**
 * One prior billable request. The user/team/model are each independently the
 * target identity or an "other" identity, so user-scope spend, team-scope
 * spend, and the model's daily count can diverge. Cost includes `0` so the
 * per-model count is exercised independently of spend.
 */
const spendEntryArb: fc.Arbitrary<SpendEntry> = fc.record({
  user: fc.constantFrom(USER, 'user-other'),
  team: fc.constantFrom(TEAM, 'team-other'),
  model: fc.constantFrom(MODEL, 'model-other'),
  cost: fc.integer({ min: 0, max: 100 }),
});

/** A full enforcement scenario. */
const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  userBudget: userBudgetArb,
  teamBudget: teamBudgetArb,
  hasTeamCtx: fc.boolean(),
  modelTier: tierArb,
  spend: fc.array(spendEntryArb, { maxLength: 12 }),
});

// ---------------------------------------------------------------------------
// Independent oracle: a from-scratch restatement of Req 22.3 / 22.5 / 22.4.
// ---------------------------------------------------------------------------

/**
 * The decision kind {@link BudgetManager.enforce} must return for `scenario`,
 * derived independently of the production code by summing per-scope spend and
 * counting the model's daily messages from the generated entries (every entry
 * is at the same instant, so all fall in the active window).
 */
function oracleKind(scenario: Scenario): BudgetDecisionKind {
  const userConsumed = scenario.spend
    .filter((e) => e.user === USER)
    .reduce((total, e) => total + e.cost, 0);
  const teamConsumed = scenario.spend
    .filter((e) => e.team === TEAM)
    .reduce((total, e) => total + e.cost, 0);
  const modelDailyCount = scenario.spend.filter(
    (e) => e.user === USER && e.model === MODEL,
  ).length;

  // 1. User-level cap blocks every billable request for the user (Req 22.3).
  if (scenario.userBudget !== undefined && userConsumed >= scenario.userBudget.limit) {
    return 'block_user_cap';
  }
  // 2. Per-model daily message limit rejects that model for the day (Req 22.5).
  if (
    scenario.userBudget !== undefined &&
    scenario.userBudget.perModelLimit !== undefined &&
    modelDailyCount >= scenario.userBudget.perModelLimit
  ) {
    return 'reject_model_daily_limit';
  }
  // 3. Team cap restricts a non-Economy request to Economy models (Req 22.4).
  if (
    scenario.hasTeamCtx &&
    scenario.teamBudget !== undefined &&
    teamConsumed >= scenario.teamBudget.limit &&
    scenario.modelTier !== 'economy'
  ) {
    return 'restrict_to_economy';
  }
  return 'allow';
}

/** Build the user {@link BudgetConfig} for a generated user budget. */
function userConfig(budget: GenUserBudget): BudgetConfig {
  const config: BudgetConfig = {
    limit: budget.limit,
    alertThreshold: budget.alertThreshold,
    period: budget.period,
  };
  if (budget.perModelLimit !== undefined) {
    config.perModelDailyMessageLimits = { [MODEL]: budget.perModelLimit };
  }
  return config;
}

/** Apply a generated scenario to a fresh manager and return the harness + ctx + request. */
async function applyScenario(
  scenario: Scenario,
): Promise<{ harness: Harness; ctx: TenantContext; req: BillableRequest }> {
  const harness = makeHarness();
  const { manager } = harness;

  if (scenario.userBudget !== undefined) {
    await manager.setBudget(
      { organizationId: ORG, userId: USER },
      userScope(ORG, USER),
      userConfig(scenario.userBudget),
    );
  }
  if (scenario.teamBudget !== undefined) {
    await manager.setBudget({ organizationId: ORG, userId: USER, teamId: TEAM }, teamScope(ORG, TEAM), {
      limit: scenario.teamBudget.limit,
      alertThreshold: scenario.teamBudget.alertThreshold,
      period: scenario.teamBudget.period,
    });
  }

  // Record prior spend through the real attribution path; vary user/team per
  // entry so the two scopes' consumed totals diverge (Req 22.1).
  for (const entry of scenario.spend) {
    await manager.recordUsage(
      { organizationId: ORG, userId: entry.user },
      { userId: entry.user, teamId: entry.team, model: entry.model, provider: 'p', cost: entry.cost },
    );
  }

  const ctx: TenantContext = scenario.hasTeamCtx
    ? { organizationId: ORG, userId: USER, teamId: TEAM }
    : { organizationId: ORG, userId: USER };
  const req: BillableRequest = { modelId: MODEL, modelTier: scenario.modelTier };
  return { harness, ctx, req };
}

// ---------------------------------------------------------------------------
// Property 43: Budget caps are enforced per scope.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 43: Budget caps are enforced per scope', () => {
  it('enforce() returns exactly the decision the documented per-scope precedence dictates (Validates: Requirements 22.3, 22.4, 22.5)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { harness, ctx, req } = await applyScenario(scenario);
        const decision = await harness.manager.enforce(ctx, req);

        const expectedKind = oracleKind(scenario);
        expect(decision.kind).toBe(expectedKind);
        expect(decision.allowed).toBe(expectedKind === 'allow');

        // The triggering scope is reported for spend-cap decisions.
        if (expectedKind === 'block_user_cap') {
          expect(decision.scope?.level).toBe('user');
        } else if (expectedKind === 'restrict_to_economy') {
          expect(decision.scope?.level).toBe('team');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('under a team cap, an Economy model is permitted while every non-Economy model is restricted (Validates: Requirements 22.4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.constantFrom<ModelTier>('standard', 'premium'),
        periodArb,
        async (limit, extra, nonEconomyTier, period) => {
          const { manager } = makeHarness();
          // Only a team cap is configured (no user budget), so the team gate is
          // the sole binding constraint.
          await manager.setBudget(
            { organizationId: ORG, userId: USER, teamId: TEAM },
            teamScope(ORG, TEAM),
            { limit, alertThreshold: 0.8, period },
          );
          await manager.recordUsage(
            { organizationId: ORG, userId: 'user-other' },
            { userId: 'user-other', teamId: TEAM, model: 'm', provider: 'p', cost: limit + extra },
          );

          const ctx: TenantContext = { organizationId: ORG, userId: USER, teamId: TEAM };

          const economy = await manager.enforce(ctx, { modelId: 'm', modelTier: 'economy' });
          expect(economy.allowed).toBe(true);
          expect(economy.kind).toBe('allow');

          const restricted = await manager.enforce(ctx, { modelId: 'm', modelTier: nonEconomyTier });
          expect(restricted.allowed).toBe(false);
          expect(restricted.kind).toBe('restrict_to_economy');
          expect(restricted.scope?.level).toBe('team');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a cap that binds in the current period no longer binds after the clock advances past the period (Validates: Requirements 22.3, 22.4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'user' | 'team'>('user', 'team'),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        periodArb,
        tierArb,
        async (scopeKind, limit, extra, period, tier) => {
          const { manager, clock } = makeHarness();
          const cost = limit + extra; // guarantees consumed >= limit in the current period

          let ctx: TenantContext;
          let req: BillableRequest;
          let expectedBlockedKind: BudgetDecisionKind;

          if (scopeKind === 'user') {
            await manager.setBudget({ organizationId: ORG, userId: USER }, userScope(ORG, USER), {
              limit,
              alertThreshold: 0.8,
              period,
            });
            await manager.recordUsage(
              { organizationId: ORG, userId: USER },
              { userId: USER, teamId: 'team-other', model: 'm', provider: 'p', cost },
            );
            ctx = { organizationId: ORG, userId: USER };
            req = { modelId: 'm', modelTier: tier };
            expectedBlockedKind = 'block_user_cap';
          } else {
            await manager.setBudget(
              { organizationId: ORG, userId: USER, teamId: TEAM },
              teamScope(ORG, TEAM),
              { limit, alertThreshold: 0.8, period },
            );
            await manager.recordUsage(
              { organizationId: ORG, userId: 'user-other' },
              { userId: 'user-other', teamId: TEAM, model: 'm', provider: 'p', cost },
            );
            ctx = { organizationId: ORG, userId: USER, teamId: TEAM };
            req = { modelId: 'm', modelTier: 'standard' }; // non-Economy so the team cap binds
            expectedBlockedKind = 'restrict_to_economy';
          }

          const before = await manager.enforce(ctx, req);
          expect(before.allowed).toBe(false);
          expect(before.kind).toBe(expectedBlockedKind);

          // Advance well past both the day and the month boundary: spend resets.
          clock.advance(62 * DAY_MS);

          const after = await manager.enforce(ctx, req);
          expect(after.allowed).toBe(true);
          expect(after.kind).toBe('allow');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
