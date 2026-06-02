/**
 * Property-based test for the Budget_Manager's cost attribution
 * (Req 22.1, design Property 42).
 *
 * Property 42 — "Cost attribution reconciles across the tenant hierarchy":
 * for any set of completed billable requests, each request's cost is attributed
 * to its originating user, Project, Team, and Organization at once, so the
 * hierarchy reconciles — an Organization's consumed total equals the sum of its
 * Teams' totals (plus any unteamed spend), which equals the sum of their
 * Projects' totals (plus any unprojected spend), which equals the sum of their
 * users' totals.
 *
 * The property is checked over >= 100 generated iterations with `fast-check`
 * against the real {@link BudgetManager} wired to the deterministic in-memory
 * fakes in `./fakes.js` — no real clock, database, or notifier. Each run:
 *
 *  1. generates an arbitrary set of billable requests, every one attributed to
 *     a fixed Organization and an arbitrary (Team, Project, user) triple — where
 *     the Team and Project may be absent (empty string), exactly as the design
 *     permits — with a non-negative integer cost;
 *  2. records every request through {@link BudgetManager.recordUsage} (with no
 *     `createdAt`, so all spend falls in the same default-month period window
 *     and counts toward `consumed`);
 *  3. asserts the manager's per-scope `consumed` totals match an independent
 *     oracle computed directly from the generated requests, and that the
 *     hierarchy reconciles up to the Organization total.
 *
 * Integer costs are generated so the partitioned sums are exactly equal (real
 * floating-point cost addition is not associative, which would make exact
 * cross-grouping reconciliation ill-defined); the reconciliation logic itself is
 * independent of the unit chosen.
 *
 * This test is intentionally self-contained — it builds its own manager harness
 * and generators and shares no module-level state with the sibling budget tests.
 *
 * **Validates: Requirements 22.1**
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { BudgetManager } from './budget-manager.js';
import {
  CapturingAuditRecorder,
  InMemoryBudgetStore,
  InMemoryUsageStore,
  MutableBudgetClock,
  sequentialBudgetIdGenerator,
} from './fakes.js';
import { organizationScope, projectScope, teamScope, userScope } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/**
 * A fixed mid-month UTC instant. The Budget_Manager measures `consumed` over the
 * default month window when a scope has no budget configured, so fixing "now"
 * here (and recording every request without an explicit `createdAt`) guarantees
 * all generated spend lands in a single period window.
 */
const NOW_ISO = '2026-06-15T12:00:00.000Z';

/** The single Organization every generated request is attributed to (org fixed). */
const ORG_ID = 'org-1';

/** Candidate Team ids; the empty string models a request with no Team (Req 22.1). */
const TEAM_IDS = ['', 'team-a', 'team-b', 'team-c'] as const;

/** Candidate Project ids; the empty string models a request with no Project (Req 22.1). */
const PROJECT_IDS = ['', 'proj-a', 'proj-b', 'proj-c'] as const;

/** Candidate user ids; every billable request always has an originating user. */
const USER_IDS = ['user-1', 'user-2', 'user-3', 'user-4'] as const;

/** Construct a BudgetManager wired with deterministic in-memory fakes at a fixed "now". */
function makeManager(): BudgetManager {
  return new BudgetManager({
    budgets: new InMemoryBudgetStore(),
    usage: new InMemoryUsageStore(),
    audit: new CapturingAuditRecorder(),
    clock: new MutableBudgetClock(Date.parse(NOW_ISO)),
    idGenerator: sequentialBudgetIdGenerator(),
  });
}

/** One generated billable request: its (Team, Project, user) attribution and cost. */
interface GeneratedRequest {
  teamId: string;
  projectId: string;
  userId: string;
  cost: number;
}

/** A single generated billable request within the fixed Organization. */
const requestArb: fc.Arbitrary<GeneratedRequest> = fc.record({
  teamId: fc.constantFrom(...TEAM_IDS),
  projectId: fc.constantFrom(...PROJECT_IDS),
  userId: fc.constantFrom(...USER_IDS),
  // Non-negative integer cost units so partitioned sums reconcile exactly.
  cost: fc.nat({ max: 100_000 }),
});

/** An arbitrary set (possibly empty) of billable requests for one Organization. */
const requestsArb: fc.Arbitrary<GeneratedRequest[]> = fc.array(requestArb, {
  minLength: 0,
  maxLength: 50,
});

/** Sum the costs that satisfy a predicate over the generated requests. */
function sumWhere(
  requests: readonly GeneratedRequest[],
  predicate: (request: GeneratedRequest) => boolean,
): number {
  return requests.reduce((total, request) => (predicate(request) ? total + request.cost : total), 0);
}

/** Group costs by a key extractor, skipping records whose key is the empty string. */
function totalsByKey(
  requests: readonly GeneratedRequest[],
  key: (request: GeneratedRequest) => string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const request of requests) {
    const id = key(request);
    if (id === '') {
      continue;
    }
    totals.set(id, (totals.get(id) ?? 0) + request.cost);
  }
  return totals;
}

describe('Feature: auxify-ai-platform, Property 42: Cost attribution reconciles across the tenant hierarchy', () => {
  it('attributes every billable request to its user, Project, Team, and Organization so the hierarchy reconciles (Req 22.1)', async () => {
    await fc.assert(
      fc.asyncProperty(requestsArb, async (requests) => {
        const manager = makeManager();

        // Record every billable request, attributing its cost up the hierarchy.
        for (const request of requests) {
          const ctx: TenantContext = { organizationId: ORG_ID, userId: request.userId };
          await manager.recordUsage(ctx, {
            teamId: request.teamId,
            projectId: request.projectId,
            userId: request.userId,
            model: 'model-x',
            provider: 'provider-x',
            cost: request.cost,
          });
        }

        // Independent oracle computed directly from the generated requests.
        const orgTotal = sumWhere(requests, () => true);
        const teamTotals = totalsByKey(requests, (r) => r.teamId);
        const projectTotals = totalsByKey(requests, (r) => r.projectId);
        const userTotals = totalsByKey(requests, (r) => r.userId);
        const unteamedTotal = sumWhere(requests, (r) => r.teamId === '');
        const unprojectedTotal = sumWhere(requests, (r) => r.projectId === '');

        // The Organization total equals the sum of every request's cost.
        expect(await manager.consumed(organizationScope(ORG_ID))).toBe(orgTotal);

        // Each Team's consumed total equals exactly that Team's recorded spend,
        // and the Teams' totals plus the unteamed spend reconcile to the org.
        let teamSum = 0;
        for (const [teamId, expected] of teamTotals) {
          const consumed = await manager.consumed(teamScope(ORG_ID, teamId));
          expect(consumed).toBe(expected);
          teamSum += consumed;
        }
        expect(teamSum + unteamedTotal).toBe(orgTotal);

        // Each Project's consumed total reconciles the same way.
        let projectSum = 0;
        for (const [projectId, expected] of projectTotals) {
          const consumed = await manager.consumed(projectScope(ORG_ID, projectId));
          expect(consumed).toBe(expected);
          projectSum += consumed;
        }
        expect(projectSum + unprojectedTotal).toBe(orgTotal);

        // Every request always carries a user, so the users' totals reconcile
        // exactly to the Organization total with no remainder.
        let userSum = 0;
        for (const [userId, expected] of userTotals) {
          const consumed = await manager.consumed(userScope(ORG_ID, userId));
          expect(consumed).toBe(expected);
          userSum += consumed;
        }
        expect(userSum).toBe(orgTotal);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
