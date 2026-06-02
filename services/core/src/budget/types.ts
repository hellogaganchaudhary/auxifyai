/**
 * Budget_Manager domain types and injectable ports (Req 22.1-22.6).
 *
 * The Budget_Manager tracks spend against configured budgets at every level of
 * the tenant hierarchy — Organization, Team, Project, and user — and decides
 * when a request must be blocked or restricted because a cap has been reached.
 * This module is the contract layer: it defines the budget configuration, the
 * usage record that spend is attributed to, the per-scope evaluation/decision
 * shapes, and the narrow ports the manager depends on by injection:
 *
 *   - {@link BudgetStore} — persists a {@link BudgetRecord} per scope and reads
 *     it back (the configured cap, alert fraction, and period).
 *   - {@link UsageStore} — appends an immutable {@link UsageRecord} and lists the
 *     records attributed to a scope within a time window. Records are retained
 *     for 2 years (Req 22.6); the period window only bounds what counts toward
 *     the *current* spend, so a budget naturally resets each period without ever
 *     deleting history.
 *   - {@link BudgetClock} — the injectable clock that fixes "now", so the period
 *     boundary (and therefore the reset) is deterministic in tests.
 *   - {@link AuditRecorder} (re-exported from `../audit`) — records budget
 *     mutations and threshold/cap crossings immutably (Req 37.2 lists budgets as
 *     a tracked domain) without a hard dependency on the Audit_Service.
 *   - {@link BudgetAlertNotifier} — the optional seam through which a crossed
 *     alert threshold notifies the responsible administrator (Req 22.2).
 *
 * The budget configuration is named {@link BudgetConfig} (not `Budget`) so it
 * never collides with the Tenancy_Service's opaque `Budget` JSONB type at the
 * shared `@auxify/core` barrel; the injectable clock is named {@link BudgetClock}
 * (not `Clock`) for the same reason — the same disambiguation the Cache_Manager
 * and Scheduler made.
 */

import type { ModelTier, TenantContext } from '@auxify/types';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

// --- Scope model (Req 22.1) ----------------------------------------------

/**
 * The level of the tenant hierarchy a budget (and the spend evaluated against
 * it) applies to (Req 22.1, 22.3, 22.4).
 *
 * A single billable request is attributed to its originating user, Project,
 * Team, and Organization at once (Req 22.1), so the same {@link UsageRecord}
 * contributes to the consumed spend at each of these levels.
 */
export type BudgetScopeLevel = 'organization' | 'team' | 'project' | 'user';

/** All {@link BudgetScopeLevel} values, for iteration, validation, and test generators. */
export const BUDGET_SCOPE_LEVELS: readonly BudgetScopeLevel[] = [
  'organization',
  'team',
  'project',
  'user',
] as const;

/**
 * A tenant-qualified identity of the entity a budget tracks spend for.
 *
 * Every scope carries its owning {@link organizationId} so a budget and its
 * usage are isolated per Organization (Req 1.4): two Organizations that happen
 * to use the same Team/Project/user id never share a budget or consumed total.
 * {@link refId} is the id of the entity at {@link level} — and equals
 * {@link organizationId} when the level is `organization`.
 */
export interface BudgetScope {
  /** The Organization that owns the scope (the tenant boundary). */
  organizationId: string;
  /** The hierarchy level the budget applies to. */
  level: BudgetScopeLevel;
  /** The id of the entity at {@link level}; equals {@link organizationId} for `organization`. */
  refId: string;
}

/** Build the Organization-level {@link BudgetScope} for an Organization. */
export function organizationScope(organizationId: string): BudgetScope {
  return { organizationId, level: 'organization', refId: organizationId };
}

/** Build the Team-level {@link BudgetScope} for a Team within an Organization. */
export function teamScope(organizationId: string, teamId: string): BudgetScope {
  return { organizationId, level: 'team', refId: teamId };
}

/** Build the Project-level {@link BudgetScope} for a Project within an Organization. */
export function projectScope(organizationId: string, projectId: string): BudgetScope {
  return { organizationId, level: 'project', refId: projectId };
}

/** Build the user-level {@link BudgetScope} for a user within an Organization. */
export function userScope(organizationId: string, userId: string): BudgetScope {
  return { organizationId, level: 'user', refId: userId };
}

// --- Budget configuration (Req 22.2-22.5) --------------------------------

/** The reset cadence of a budget: a calendar day or a calendar month, in UTC (Req 22.3-22.5). */
export type BudgetPeriod = 'day' | 'month';

/** All {@link BudgetPeriod} values, for iteration, validation, and test generators. */
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['day', 'month'] as const;

/**
 * A configurable spend cap and alert threshold for one scope (design `Budget`,
 * Req 22.2-22.5).
 *
 * {@link limit} is the spend cap in the platform's accounting currency.
 * {@link alertThreshold} is the *fraction* of the cap (in the half-open range
 * `(0, 1]`) at which the responsible administrator is notified (Req 22.2): a
 * threshold of `0.8` warns at 80% of the cap. {@link period} is the window the
 * cap and threshold are measured over, after which consumed spend resets to
 * zero (Req 22.3-22.5). {@link perModelDailyMessageLimits} optionally caps the
 * number of billable requests to a specific model per UTC day (Req 22.5).
 */
export interface BudgetConfig {
  /** The spend cap for the period, in the accounting currency (Req 22.3, 22.4). */
  limit: number;
  /** The fraction of {@link limit} `(0, 1]` at which to notify the admin (Req 22.2). */
  alertThreshold: number;
  /** The window the cap/threshold are measured over and reset after (Req 22.3-22.5). */
  period: BudgetPeriod;
  /** Optional per-model daily message caps, keyed by model id (Req 22.5). */
  perModelDailyMessageLimits?: Record<string, number>;
}

/**
 * A persisted budget: a {@link BudgetConfig} bound to a {@link BudgetScope} with
 * audit timestamps. Stored and read back through the {@link BudgetStore}.
 */
export interface BudgetRecord {
  /** The Organization that owns the budget (the tenant boundary). */
  organizationId: string;
  /** The hierarchy level the budget applies to. */
  level: BudgetScopeLevel;
  /** The id of the entity at {@link level}; equals {@link organizationId} for `organization`. */
  refId: string;
  /** The spend cap for the period (Req 22.3, 22.4). */
  limit: number;
  /** The alert fraction `(0, 1]` of {@link limit} (Req 22.2). */
  alertThreshold: number;
  /** The reset cadence of the cap/threshold (Req 22.3-22.5). */
  period: BudgetPeriod;
  /** Optional per-model daily message caps, keyed by model id (Req 22.5). */
  perModelDailyMessageLimits?: Record<string, number>;
  /** ISO-8601 instant the budget was first set. */
  createdAt: string;
  /** ISO-8601 instant the budget was last updated. */
  updatedAt: string;
}

// --- Usage attribution (Req 22.1, 22.6) ----------------------------------

/**
 * An immutable record of one completed billable request's cost, attributed to
 * its originating user, Project, Team, and Organization (design `UsageRecord`,
 * Req 22.1, 31.1).
 *
 * The same record contributes to the consumed spend at every hierarchy level,
 * which is exactly what makes the hierarchy reconcile: an Organization's total
 * is the sum of its Teams' totals, which is the sum of their Projects' totals,
 * which is the sum of their users' totals (Property 42). Records are retained
 * for 2 years (Req 22.6) and never deleted on a period reset.
 */
export interface UsageRecord {
  /** The record's stable unique id. */
  id: string;
  /** The Organization the cost is attributed to (Req 22.1). */
  organizationId: string;
  /** The Team the cost is attributed to; empty string when none applies (Req 22.1). */
  teamId: string;
  /** The Project the cost is attributed to; empty string when none applies (Req 22.1). */
  projectId: string;
  /** The user the cost is attributed to (Req 22.1). */
  userId: string;
  /** The model that served the request. */
  model: string;
  /** The provider that served the request. */
  provider: string;
  /** Input (prompt) token count. */
  inputTokens: number;
  /** Output (completion) token count. */
  outputTokens: number;
  /** The computed cost of the request, in the accounting currency (Req 22.1). */
  cost: number;
  /** Request latency in milliseconds. */
  latencyMs: number;
  /** The kind of billable request (e.g. `chat`, `embedding`, `image`). */
  requestType: string;
  /** Number of tool invocations performed during the request. */
  toolCallCount: number;
  /** ISO-8601 instant the request completed (Req 22.6, 31.1). */
  createdAt: string;
}

/**
 * The fields to record one completed billable request (Req 22.1).
 *
 * The Organization and user default from the caller's {@link TenantContext};
 * the Team and Project may be supplied explicitly to attribute the cost up the
 * hierarchy. {@link createdAt} defaults to the {@link BudgetClock}'s "now", so
 * tests can place a record in a specific period.
 */
export interface RecordUsageInput {
  /** Explicit usage-record id; generated when omitted. */
  id?: string;
  /** The Team to attribute the cost to; defaults to `ctx.teamId` then empty. */
  teamId?: string;
  /** The Project to attribute the cost to; defaults to `ctx.projectId` then empty. */
  projectId?: string;
  /** The user to attribute the cost to; defaults to `ctx.userId`. */
  userId?: string;
  /** The model that served the request. */
  model: string;
  /** The provider that served the request. */
  provider: string;
  /** Input (prompt) token count; defaults to `0`. */
  inputTokens?: number;
  /** Output (completion) token count; defaults to `0`. */
  outputTokens?: number;
  /** The computed cost of the request (Req 22.1). */
  cost: number;
  /** Request latency in milliseconds; defaults to `0`. */
  latencyMs?: number;
  /** The kind of billable request; defaults to `chat`. */
  requestType?: string;
  /** Number of tool invocations; defaults to `0`. */
  toolCallCount?: number;
  /** ISO-8601 completion instant; defaults to the clock's "now". */
  createdAt?: string;
}

// --- Period model (Req 22.3-22.5) ----------------------------------------

/**
 * A half-open `[startMs, endMs)` epoch-ms window covering the current budget
 * period. Spend within the window counts toward the cap; once the clock passes
 * {@link endMs} a new window applies and consumed spend resets (Req 22.3-22.5).
 */
export interface PeriodWindow {
  /** Inclusive lower bound of the period (epoch ms). */
  startMs: number;
  /** Exclusive upper bound of the period (epoch ms). */
  endMs: number;
}

// --- Evaluation + decision (Req 22.2-22.5) -------------------------------

/**
 * The status of a scope's spend against its budget (Req 22.2, 22.3, 22.4).
 *
 *  - `no_budget` — no budget is configured for the scope.
 *  - `under` — spend is below the alert threshold.
 *  - `threshold_warning` — spend has reached the alert threshold but is below
 *    the cap; the responsible administrator should be notified (Req 22.2).
 *  - `at_or_over_cap` — spend has reached or exceeded the cap (Req 22.3, 22.4).
 */
export type BudgetStatusLevel = 'no_budget' | 'under' | 'threshold_warning' | 'at_or_over_cap';

/** All {@link BudgetStatusLevel} values, for iteration, validation, and test generators. */
export const BUDGET_STATUS_LEVELS: readonly BudgetStatusLevel[] = [
  'no_budget',
  'under',
  'threshold_warning',
  'at_or_over_cap',
] as const;

/**
 * The non-mutating evaluation of a scope's current spend against its budget for
 * the active period (Req 22.2, 22.3, 22.4).
 *
 * This is the "status type" the Billing_Guard (task 19.7) and the per-scope
 * enforcement (task 19.6) consume: it reports the {@link status}, the cap, the
 * consumed and remaining amounts, the alert fraction and the absolute amount it
 * corresponds to, and the period window the consumption was measured over.
 */
export interface BudgetEvaluation {
  /** The scope that was evaluated. */
  scope: BudgetScope;
  /** The spend status against the cap and alert threshold. */
  status: BudgetStatusLevel;
  /** The configured cap, or `null` when no budget is set. */
  limit: number | null;
  /** The spend consumed within the active period. */
  consumed: number;
  /** `limit - consumed` (may be negative when over), or `null` when no budget is set. */
  remaining: number | null;
  /** The configured alert fraction `(0, 1]`, or `null` when no budget is set. */
  alertThreshold: number | null;
  /** The absolute spend the alert fraction corresponds to (`limit * alertThreshold`), or `null`. */
  thresholdAmount: number | null;
  /** The period window consumption was measured over. */
  period: PeriodWindow;
}

/**
 * The kind of decision the Budget_Manager renders for a billable request
 * (Req 22.3, 22.4, 22.5).
 *
 *  - `allow` — no cap blocks the request.
 *  - `block_user_cap` — the user reached the user-level cap; block until reset
 *    (Req 22.3).
 *  - `restrict_to_economy` — the Team reached the team-level cap; only Economy
 *    models are permitted until reset, so a non-Economy request is refused
 *    (Req 22.4).
 *  - `reject_model_daily_limit` — the user exceeded the per-model daily message
 *    limit; reject further requests to that model for the day (Req 22.5).
 */
export type BudgetDecisionKind =
  | 'allow'
  | 'block_user_cap'
  | 'restrict_to_economy'
  | 'reject_model_daily_limit';

/**
 * The structured verdict for a billable request (Req 22.3, 22.4, 22.5).
 *
 * {@link allowed} is the single fail-closed answer the request path branches on;
 * {@link kind} names which cap (if any) applied, {@link reason} is a
 * human-readable explanation, and {@link scope}/{@link evaluation} carry the
 * triggering scope and its evaluation for logging and the Billing_Guard.
 */
export interface BudgetDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Which cap applied (or `allow`). */
  kind: BudgetDecisionKind;
  /** A human-readable, secret-free explanation of the decision. */
  reason: string;
  /** The scope whose cap produced a non-`allow` decision, when applicable. */
  scope?: BudgetScope;
  /** The triggering scope's evaluation, when a spend cap produced the decision. */
  evaluation?: BudgetEvaluation;
}

/**
 * A billable request the Budget_Manager evaluates caps against (Req 22.3-22.5).
 *
 * Carries the target model and its tier (so a team cap can permit only Economy
 * models, Req 22.4) and the request's tenant scope through the
 * {@link TenantContext} the caller passes alongside it.
 */
export interface BillableRequest {
  /** The id of the model the request targets (Req 22.5). */
  modelId: string;
  /** The tier of the target model; a team cap permits only `economy` (Req 22.4). */
  modelTier: ModelTier;
  /** The estimated cost of the request, when known (informational). */
  estimatedCost?: number;
}

// --- Injectable ports ----------------------------------------------------

/**
 * The clock the Budget_Manager reads to fix "now" when stamping usage records
 * and computing the active period window.
 *
 * Injectable so tests can place spend in a specific period and advance across a
 * period boundary to assert the reset (Req 22.3-22.5). Named {@link BudgetClock}
 * (not `Clock`) so it never collides with the Model_Router's clock in the shared
 * `@auxify/core` barrel.
 */
export interface BudgetClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link BudgetClock}, backed by the global `Date.now`. */
export const systemBudgetClock: BudgetClock = { now: () => Date.now() };

/**
 * The persistence port for a scope's budget configuration.
 *
 * Implementations key a {@link BudgetRecord} by `(organizationId, level, refId)`
 * so budgets are isolated per Organization (Req 1.4). The concrete backend is a
 * tenant-scoped repository in production; tests use the in-memory fake.
 */
export interface BudgetStore {
  /**
   * Return the budget configured for a scope, or `null` when none is set.
   *
   * @param organizationId The owning Organization (tenant boundary).
   * @param level The hierarchy level.
   * @param refId The id of the entity at `level`.
   */
  get(
    organizationId: string,
    level: BudgetScopeLevel,
    refId: string,
  ): Promise<BudgetRecord | null>;

  /**
   * Insert or replace the budget for a scope.
   *
   * @param record The budget to persist.
   */
  set(record: BudgetRecord): Promise<void>;
}

/** A scope- and window-bounded query for attributed usage records. */
export interface UsageQuery {
  /** The Organization to scope to (tenant boundary). */
  organizationId: string;
  /** The hierarchy level whose attribution column is matched. */
  level: BudgetScopeLevel;
  /** The id of the entity at {@link level} to match. */
  refId: string;
  /** Inclusive lower bound of the window (epoch ms). */
  fromMs: number;
  /** Exclusive upper bound of the window (epoch ms). */
  toMs: number;
  /** When set, restrict to records for this model id (for per-model daily limits, Req 22.5). */
  model?: string;
}

/**
 * The persistence port for immutable usage records (Req 22.1, 22.6).
 *
 * Records are append-only and retained for 2 years (Req 22.6). {@link list}
 * returns the records attributed to a scope within a half-open `[fromMs, toMs)`
 * window, which is how the manager computes consumed spend for the active
 * period and counts per-model daily messages. The concrete backend is the
 * monthly-partitioned `usage_records` table (Req 44.7) in production; tests use
 * the in-memory fake.
 */
export interface UsageStore {
  /**
   * Append one immutable usage record.
   *
   * @param record The record to store.
   */
  append(record: UsageRecord): Promise<void>;

  /**
   * List the usage records matching a scope within a time window.
   *
   * @param query The scope, window, and optional model filter.
   */
  list(query: UsageQuery): Promise<UsageRecord[]>;
}

/**
 * A budget alert raised when a scope crosses its alert threshold or its cap
 * (Req 22.2).
 *
 * {@link kind} distinguishes the alert-threshold warning (Req 22.2) from the cap
 * being reached (Req 22.3, 22.4). The {@link scope}, cap, consumed amount, alert
 * fraction, and period window let the notifier route the alert to the
 * responsible administrator with full context.
 */
export interface BudgetAlert {
  /** Whether the alert fraction or the cap was crossed. */
  kind: 'threshold_warning' | 'cap_reached';
  /** The scope whose spend crossed a boundary. */
  scope: BudgetScope;
  /** The configured cap. */
  limit: number;
  /** The consumed spend after the crossing record. */
  consumed: number;
  /** The configured alert fraction `(0, 1]`. */
  alertThreshold: number;
  /** The period window the consumption was measured over. */
  period: PeriodWindow;
}

/**
 * The optional seam through which a crossed alert threshold (or cap) notifies
 * the responsible administrator (Req 22.2).
 *
 * The Budget_Manager always records a crossing as an immutable audit event; a
 * {@link BudgetAlertNotifier} additionally delivers the alert out of band (an
 * email, a webhook, an in-app notification). Optional: when none is injected the
 * crossing is still audited.
 */
export interface BudgetAlertNotifier {
  /**
   * Deliver a budget alert to the responsible administrator.
   *
   * @param ctx The tenant context the spend occurred in.
   * @param alert The crossed-threshold or cap-reached alert.
   */
  notify(ctx: TenantContext, alert: BudgetAlert): Promise<void>;
}
