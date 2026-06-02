/**
 * The Budget_Manager (Req 22.1-22.6).
 *
 * Tracks spend against configured budgets at every level of the tenant
 * hierarchy and decides when a billable request must be blocked or restricted
 * because a cap has been reached. It is pure orchestration over five injectable
 * ports — a {@link BudgetStore}, a {@link UsageStore}, an {@link AuditRecorder},
 * a {@link BudgetClock}, and an optional {@link BudgetAlertNotifier} — so it is
 * fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * The public surface is deliberately small and guard-friendly so the
 * Billing_Guard (task 19.7) can compose it through a narrow port:
 *
 *   - {@link BudgetManager.setBudget} / {@link BudgetManager.getBudget} — set
 *     and read a scope's budget (validated, audited on set, Req 22.2-22.5).
 *   - {@link BudgetManager.recordUsage} — attribute one completed billable
 *     request's cost to its originating user, Project, Team, and Organization
 *     (Req 22.1), and notify + audit the responsible administrator when the
 *     spend crosses a configured alert threshold or cap (Req 22.2).
 *   - {@link BudgetManager.consumed} — the spend consumed by a scope in its
 *     active period.
 *   - {@link BudgetManager.evaluate} — the non-mutating {@link BudgetEvaluation}
 *     status (under / threshold-warning / at-or-over-cap) with consumed and
 *     remaining amounts (Req 22.2-22.4).
 *   - {@link BudgetManager.enforce} — the fail-closed {@link BudgetDecision} for
 *     a billable request: block a user at the user cap (Req 22.3), restrict a
 *     team at the team cap to Economy models (Req 22.4), and reject a model that
 *     exceeded its per-model daily message limit for the day (Req 22.5).
 *
 * Every consumed-spend figure is measured over the budget's *current* period
 * window (Req 22.3-22.5); the window simply advances each period, so a budget
 * resets without ever deleting the 2-year-retained usage history (Req 22.6).
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { InvalidBudgetConfigError } from './errors.js';
import { dayWindow, periodWindow } from './period.js';
import {
  type AuditRecorder,
  type BillableRequest,
  type BudgetAlert,
  type BudgetAlertNotifier,
  type BudgetClock,
  type BudgetConfig,
  type BudgetDecision,
  type BudgetEvaluation,
  type BudgetPeriod,
  type BudgetRecord,
  type BudgetScope,
  type BudgetScopeLevel,
  type BudgetStatusLevel,
  type BudgetStore,
  type PeriodWindow,
  type RecordUsageInput,
  type UsageRecord,
  type UsageStore,
  systemBudgetClock,
} from './types.js';

/** The default period used to compute consumed spend for a scope that has no budget set. */
const DEFAULT_NO_BUDGET_PERIOD: BudgetPeriod = 'month';

/** Generates unique usage-record ids (injectable for deterministic tests). */
export interface BudgetIdGenerator {
  /** A unique usage-record id. */
  usageId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: BudgetIdGenerator = {
  usageId: () => randomUUID(),
};

/** Construction options for the {@link BudgetManager}. */
export interface BudgetManagerOptions {
  /** The budget-configuration store (per-scope cap/threshold/period). */
  budgets: BudgetStore;
  /** The immutable usage-record store (Req 22.1, 22.6). */
  usage: UsageStore;
  /** The append-only audit sink; budget mutations and crossings are recorded through it (Req 37.2). */
  audit: AuditRecorder;
  /** Optional clock for "now" (defaults to {@link systemBudgetClock}), for deterministic tests. */
  clock?: BudgetClock;
  /** Optional out-of-band administrator notifier for alert crossings (Req 22.2). */
  notifier?: BudgetAlertNotifier;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: BudgetIdGenerator;
}

/** The recorded outcome of attributing one billable request's cost (Req 22.1, 22.2). */
export interface RecordUsageResult {
  /** The appended immutable usage record. */
  record: UsageRecord;
  /** The alert crossings raised by this record (threshold and/or cap), in scope order. */
  alerts: BudgetAlert[];
}

/**
 * The Budget_Manager: tracks spend, computes remaining budget, evaluates status,
 * and enforces per-scope caps (Req 22.1-22.6).
 */
export class BudgetManager {
  private readonly budgets: BudgetStore;
  private readonly usage: UsageStore;
  private readonly audit: AuditRecorder;
  private readonly clock: BudgetClock;
  private readonly notifier: BudgetAlertNotifier | undefined;
  private readonly ids: BudgetIdGenerator;

  constructor(options: BudgetManagerOptions) {
    this.budgets = options.budgets;
    this.usage = options.usage;
    this.audit = options.audit;
    this.clock = options.clock ?? systemBudgetClock;
    this.notifier = options.notifier;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Set (insert or replace) the budget for a scope (Req 22.2-22.5).
   *
   * Validates the configuration ({@link InvalidBudgetConfigError} on a negative
   * cap, an alert fraction outside `(0, 1]`, or a non-positive per-model daily
   * limit), persists it, and records an immutable `budget.set` audit event.
   *
   * @param ctx The tenant context; its Organization must own the scope.
   * @param scope The scope the budget applies to.
   * @param config The cap, alert fraction, period, and optional per-model limits.
   * @returns The persisted {@link BudgetRecord}.
   */
  async setBudget(
    ctx: TenantContext,
    scope: BudgetScope,
    config: BudgetConfig,
  ): Promise<BudgetRecord> {
    this.assertScopeInTenant(ctx, scope);
    validateBudgetConfig(config);

    const existing = await this.budgets.get(scope.organizationId, scope.level, scope.refId);
    const nowIso = new Date(this.clock.now()).toISOString();
    const record: BudgetRecord = {
      organizationId: scope.organizationId,
      level: scope.level,
      refId: scope.refId,
      limit: config.limit,
      alertThreshold: config.alertThreshold,
      period: config.period,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    if (config.perModelDailyMessageLimits !== undefined) {
      record.perModelDailyMessageLimits = { ...config.perModelDailyMessageLimits };
    }
    await this.budgets.set(record);

    await this.audit.record(ctx, {
      action: 'budget.set',
      resourceType: 'usage_record',
      resourceId: scopeKey(scope),
      timestamp: nowIso,
      metadata: {
        level: scope.level,
        refId: scope.refId,
        limit: config.limit,
        alertThreshold: config.alertThreshold,
        period: config.period,
      },
    });

    return record;
  }

  /**
   * Return the budget configured for a scope, or `null` when none is set.
   *
   * @param scope The scope to read the budget for.
   */
  async getBudget(scope: BudgetScope): Promise<BudgetRecord | null> {
    return this.budgets.get(scope.organizationId, scope.level, scope.refId);
  }

  /**
   * Attribute one completed billable request's cost to its originating user,
   * Project, Team, and Organization (Req 22.1), then notify + audit the
   * responsible administrator for any scope whose spend crossed its alert
   * threshold or cap as a result (Req 22.2).
   *
   * The single appended {@link UsageRecord} contributes to the consumed spend at
   * each hierarchy level, which is what makes the hierarchy reconcile
   * (Property 42).
   *
   * @param ctx The tenant context; supplies the default Organization/user/Team/Project attribution.
   * @param input The completed request's cost and attribution.
   * @returns The appended record and any alert crossings it caused.
   */
  async recordUsage(ctx: TenantContext, input: RecordUsageInput): Promise<RecordUsageResult> {
    const nowMs = this.clock.now();
    const createdAt = input.createdAt ?? new Date(nowMs).toISOString();
    const createdAtMs = Date.parse(createdAt);

    const record: UsageRecord = {
      id: input.id ?? this.ids.usageId(),
      organizationId: ctx.organizationId,
      teamId: input.teamId ?? ctx.teamId ?? '',
      projectId: input.projectId ?? ctx.projectId ?? '',
      userId: input.userId ?? ctx.userId,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cost: input.cost,
      latencyMs: input.latencyMs ?? 0,
      requestType: input.requestType ?? 'chat',
      toolCallCount: input.toolCallCount ?? 0,
      createdAt,
    };
    await this.usage.append(record);

    // Detect threshold/cap crossings for each scope the cost is attributed to.
    const scopes = this.attributedScopes(record);
    const alerts: BudgetAlert[] = [];
    for (const scope of scopes) {
      const crossings = await this.detectCrossings(scope, record, createdAtMs);
      for (const alert of crossings) {
        alerts.push(alert);
        await this.recordAlert(ctx, alert, createdAt);
      }
    }

    return { record, alerts };
  }

  /**
   * Compute the spend a scope has consumed within its active period (Req 22.3,
   * 22.4). When the scope has no budget, the consumption is measured over the
   * default {@link DEFAULT_NO_BUDGET_PERIOD} window for completeness.
   *
   * @param scope The scope to total spend for.
   * @returns The consumed spend in the accounting currency.
   */
  async consumed(scope: BudgetScope): Promise<number> {
    const budget = await this.getBudget(scope);
    const period = budget?.period ?? DEFAULT_NO_BUDGET_PERIOD;
    const window = periodWindow(period, this.clock.now());
    return this.consumedInWindow(scope, window);
  }

  /**
   * Evaluate a scope's current spend against its budget for the active period,
   * without mutating anything (Req 22.2, 22.3, 22.4).
   *
   * This is the status type the per-scope enforcement and the Billing_Guard
   * (task 19.7) consume: it reports the {@link BudgetStatusLevel}, the cap, the
   * consumed and remaining amounts, the alert fraction and the absolute amount
   * it corresponds to, and the period window the consumption was measured over.
   *
   * @param scope The scope to evaluate.
   * @returns The scope's {@link BudgetEvaluation}.
   */
  async evaluate(scope: BudgetScope): Promise<BudgetEvaluation> {
    const budget = await this.getBudget(scope);
    const period = budget?.period ?? DEFAULT_NO_BUDGET_PERIOD;
    const window = periodWindow(period, this.clock.now());
    const consumed = await this.consumedInWindow(scope, window);

    if (budget === null) {
      return {
        scope,
        status: 'no_budget',
        limit: null,
        consumed,
        remaining: null,
        alertThreshold: null,
        thresholdAmount: null,
        period: window,
      };
    }

    const thresholdAmount = budget.limit * budget.alertThreshold;
    return {
      scope,
      status: statusFor(consumed, budget.limit, thresholdAmount),
      limit: budget.limit,
      consumed,
      remaining: budget.limit - consumed,
      alertThreshold: budget.alertThreshold,
      thresholdAmount,
      period: window,
    };
  }

  /**
   * Render the fail-closed {@link BudgetDecision} for a billable request
   * (Req 22.3, 22.4, 22.5).
   *
   * Checks, in fail-closed precedence (strictest first):
   *   1. the user-level cap — block the user from further billable requests
   *      until the cap resets (Req 22.3);
   *   2. the per-model daily message limit on the user's budget — reject further
   *      requests to that model for the remainder of the day (Req 22.5);
   *   3. the team-level cap — when reached, permit only Economy models, so a
   *      non-Economy request is restricted (Req 22.4).
   *
   * @param ctx The tenant context the request runs in; `userId` identifies the
   *   user scope and `teamId` (when present) the team scope.
   * @param req The billable request (target model id and tier).
   * @returns The decision; `allowed` is the single answer the request path branches on.
   */
  async enforce(ctx: TenantContext, req: BillableRequest): Promise<BudgetDecision> {
    const nowMs = this.clock.now();
    const userScopeRef: BudgetScope = {
      organizationId: ctx.organizationId,
      level: 'user',
      refId: ctx.userId,
    };

    // 1. User-level cap blocks every billable request for the user (Req 22.3).
    const userEval = await this.evaluate(userScopeRef);
    if (userEval.status === 'at_or_over_cap') {
      return {
        allowed: false,
        kind: 'block_user_cap',
        reason: `User "${ctx.userId}" has reached the user-level spend cap; requests are blocked until the cap resets`,
        scope: userScopeRef,
        evaluation: userEval,
      };
    }

    // 2. Per-model daily message limit rejects that model for the day (Req 22.5).
    const userBudget = await this.getBudget(userScopeRef);
    const perModelLimit = userBudget?.perModelDailyMessageLimits?.[req.modelId];
    if (perModelLimit !== undefined) {
      const day = dayWindow(nowMs);
      const messagesToday = await this.usage.list({
        organizationId: ctx.organizationId,
        level: 'user',
        refId: ctx.userId,
        fromMs: day.startMs,
        toMs: day.endMs,
        model: req.modelId,
      });
      if (messagesToday.length >= perModelLimit) {
        return {
          allowed: false,
          kind: 'reject_model_daily_limit',
          reason: `User "${ctx.userId}" exceeded the daily message limit of ${perModelLimit} for model "${req.modelId}"; rejected for the remainder of the day`,
          scope: userScopeRef,
        };
      }
    }

    // 3. Team-level cap restricts the team to Economy models (Req 22.4).
    if (ctx.teamId !== undefined && ctx.teamId !== '') {
      const teamScopeRef: BudgetScope = {
        organizationId: ctx.organizationId,
        level: 'team',
        refId: ctx.teamId,
      };
      const teamEval = await this.evaluate(teamScopeRef);
      if (teamEval.status === 'at_or_over_cap' && req.modelTier !== 'economy') {
        return {
          allowed: false,
          kind: 'restrict_to_economy',
          reason: `Team "${ctx.teamId}" has reached the team-level spend cap; only Economy models are permitted until the cap resets`,
          scope: teamScopeRef,
          evaluation: teamEval,
        };
      }
    }

    return { allowed: true, kind: 'allow', reason: 'No budget cap blocks the request' };
  }

  // --- internals ---------------------------------------------------------

  /** The four scopes a usage record's cost is attributed to (Req 22.1). */
  private attributedScopes(record: UsageRecord): BudgetScope[] {
    const scopes: BudgetScope[] = [
      { organizationId: record.organizationId, level: 'organization', refId: record.organizationId },
    ];
    if (record.teamId !== '') {
      scopes.push({ organizationId: record.organizationId, level: 'team', refId: record.teamId });
    }
    if (record.projectId !== '') {
      scopes.push({
        organizationId: record.organizationId,
        level: 'project',
        refId: record.projectId,
      });
    }
    scopes.push({ organizationId: record.organizationId, level: 'user', refId: record.userId });
    return scopes;
  }

  /**
   * Detect whether appending `record` pushed `scope` across its alert threshold
   * and/or its cap, comparing the spend just before and just after the record
   * (so a crossing is reported once, not on every subsequent request).
   */
  private async detectCrossings(
    scope: BudgetScope,
    record: UsageRecord,
    createdAtMs: number,
  ): Promise<BudgetAlert[]> {
    const budget = await this.getBudget(scope);
    if (budget === null || record.cost <= 0) {
      return [];
    }
    const window = periodWindow(budget.period, createdAtMs);
    // Only a record inside the active period can move that period's spend.
    if (createdAtMs < window.startMs || createdAtMs >= window.endMs) {
      return [];
    }
    const after = await this.consumedInWindow(scope, window);
    const before = after - record.cost;
    const thresholdAmount = budget.limit * budget.alertThreshold;

    const alerts: BudgetAlert[] = [];
    if (before < thresholdAmount && after >= thresholdAmount) {
      alerts.push(buildAlert('threshold_warning', scope, budget, after, window));
    }
    if (before < budget.limit && after >= budget.limit) {
      alerts.push(buildAlert('cap_reached', scope, budget, after, window));
    }
    return alerts;
  }

  /** Record an alert crossing immutably and notify the administrator out of band (Req 22.2). */
  private async recordAlert(
    ctx: TenantContext,
    alert: BudgetAlert,
    timestamp: string,
  ): Promise<void> {
    await this.audit.record(ctx, {
      action: alert.kind === 'cap_reached' ? 'budget.cap_reached' : 'budget.threshold_warning',
      resourceType: 'usage_record',
      resourceId: scopeKey(alert.scope),
      timestamp,
      metadata: {
        level: alert.scope.level,
        refId: alert.scope.refId,
        limit: alert.limit,
        consumed: alert.consumed,
        alertThreshold: alert.alertThreshold,
      },
    });
    if (this.notifier !== undefined) {
      await this.notifier.notify(ctx, alert);
    }
  }

  /** Sum the cost of every usage record attributed to `scope` within `window`. */
  private async consumedInWindow(scope: BudgetScope, window: PeriodWindow): Promise<number> {
    const records = await this.usage.list({
      organizationId: scope.organizationId,
      level: scope.level,
      refId: scope.refId,
      fromMs: window.startMs,
      toMs: window.endMs,
    });
    return records.reduce((total, record) => total + record.cost, 0);
  }

  /** Fail closed if a scope is not within the caller's Organization (Req 1.4). */
  private assertScopeInTenant(ctx: TenantContext, scope: BudgetScope): void {
    if (scope.organizationId !== ctx.organizationId) {
      throw new InvalidBudgetConfigError(
        `scope Organization "${scope.organizationId}" does not match the tenant context Organization "${ctx.organizationId}"`,
      );
    }
  }
}

/** Compose a stable key for a scope, used as an audit resource id and for messages. */
function scopeKey(scope: BudgetScope): string {
  return `${scope.level}:${scope.refId}`;
}

/** Classify consumed spend against a cap and its absolute threshold amount. */
function statusFor(
  consumed: number,
  limit: number,
  thresholdAmount: number,
): BudgetStatusLevel {
  if (consumed >= limit) {
    return 'at_or_over_cap';
  }
  if (consumed >= thresholdAmount) {
    return 'threshold_warning';
  }
  return 'under';
}

/** Build a {@link BudgetAlert} from a crossing. */
function buildAlert(
  kind: BudgetAlert['kind'],
  scope: BudgetScope,
  budget: BudgetRecord,
  consumed: number,
  window: PeriodWindow,
): BudgetAlert {
  return {
    kind,
    scope,
    limit: budget.limit,
    consumed,
    alertThreshold: budget.alertThreshold,
    period: window,
  };
}

/**
 * Validate a budget configuration, throwing {@link InvalidBudgetConfigError} on
 * any structurally invalid field (Req 22.2-22.5).
 *
 * @param config The configuration to validate.
 * @param scopeLevel Optional scope level, included in error messages for context.
 */
export function validateBudgetConfig(config: BudgetConfig, scopeLevel?: BudgetScopeLevel): void {
  const where = scopeLevel !== undefined ? ` for ${scopeLevel} scope` : '';
  if (!Number.isFinite(config.limit) || config.limit < 0) {
    throw new InvalidBudgetConfigError(`limit${where} must be a finite, non-negative number`);
  }
  if (
    !Number.isFinite(config.alertThreshold) ||
    config.alertThreshold <= 0 ||
    config.alertThreshold > 1
  ) {
    throw new InvalidBudgetConfigError(`alertThreshold${where} must be in the range (0, 1]`);
  }
  if (config.period !== 'day' && config.period !== 'month') {
    throw new InvalidBudgetConfigError(`period${where} must be "day" or "month"`);
  }
  if (config.perModelDailyMessageLimits !== undefined) {
    for (const [model, limit] of Object.entries(config.perModelDailyMessageLimits)) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new InvalidBudgetConfigError(
          `per-model daily message limit for "${model}"${where} must be a positive integer`,
        );
      }
    }
  }
}
