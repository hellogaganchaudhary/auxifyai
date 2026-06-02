/**
 * Budget_Manager (Req 22.1-22.6).
 *
 * Tracks spend against configured budgets at every level of the tenant
 * hierarchy — Organization, Team, Project, and user — and decides when a
 * billable request must be blocked or restricted because a cap has been reached.
 * It is pure orchestration over five injectable ports — a {@link BudgetStore}, a
 * {@link UsageStore}, an {@link import('../audit/index.js').AuditRecorder}, a
 * {@link BudgetClock}, and an optional {@link BudgetAlertNotifier} — so it is
 * fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Surface:
 *   - {@link BudgetManager} — the service; one method per acceptance criterion:
 *     `setBudget`/`getBudget` set and read a scope's validated budget, auditing
 *     the mutation (Req 22.2-22.5); `recordUsage` attributes one completed
 *     billable request's cost to its originating user, Project, Team, and
 *     Organization at once (Req 22.1) and notifies + audits the responsible
 *     administrator on a crossed alert threshold or cap (Req 22.2); `consumed`
 *     totals a scope's spend in its active period; `evaluate` returns the
 *     non-mutating {@link BudgetEvaluation} status (under / threshold-warning /
 *     at-or-over-cap) with consumed and remaining amounts (Req 22.2-22.4); and
 *     `enforce` renders the fail-closed {@link BudgetDecision} — block a user at
 *     the user cap (Req 22.3), restrict a team at the team cap to Economy models
 *     (Req 22.4), and reject a model over its per-model daily message limit for
 *     the day (Req 22.5).
 *   - {@link validateBudgetConfig} — the pure configuration validator that
 *     fails closed with {@link InvalidBudgetConfigError} on a negative cap, an
 *     alert fraction outside the half-open range from 0 to 1, an unknown period,
 *     or a non-positive per-model daily limit (Req 22.2-22.5).
 *   - The scope builders {@link organizationScope}, {@link teamScope},
 *     {@link projectScope}, {@link userScope} and the period helpers
 *     {@link periodWindow} / {@link dayWindow} that compute the half-open
 *     `[startMs, endMs)` window a budget resets across (Req 22.3-22.5).
 *   - The injectable ports the service composes — {@link BudgetStore},
 *     {@link UsageStore}, {@link BudgetClock}, {@link BudgetAlertNotifier},
 *     {@link BudgetIdGenerator} — plus the production default
 *     {@link systemBudgetClock}.
 *   - Domain types ({@link BudgetScope}, {@link BudgetConfig},
 *     {@link BudgetRecord}, {@link UsageRecord}, {@link RecordUsageInput},
 *     {@link PeriodWindow}, {@link BudgetEvaluation}, {@link BudgetDecision},
 *     {@link BillableRequest}, {@link BudgetAlert}, {@link UsageQuery},
 *     {@link RecordUsageResult}, {@link BudgetManagerOptions}), the string-union
 *     vocabularies ({@link BudgetScopeLevel}, {@link BudgetPeriod},
 *     {@link BudgetStatusLevel}, {@link BudgetDecisionKind}) with their value
 *     lists ({@link BUDGET_SCOPE_LEVELS}, {@link BUDGET_PERIODS},
 *     {@link BUDGET_STATUS_LEVELS}), and the typed errors plus their stable
 *     codes ({@link InvalidBudgetConfigError}, {@link quotaExceededError},
 *     {@link INVALID_BUDGET_CONFIG_CODE}, {@link BUDGET_QUOTA_EXCEEDED_CODE}).
 *
 * The in-memory test fakes (a hand-advanced clock, in-memory budget/usage
 * stores, a capturing audit recorder, a recording alert notifier, and a
 * sequential id generator) live in `./fakes.js` and are intentionally NOT
 * re-exported from this barrel — they would collide with the equally-named
 * audit-recorder fakes of sibling modules at the package barrel. Following the
 * established convention, the tests import them directly from `./fakes.js`. The
 * {@link import('../audit/index.js').AuditRecorder} /
 * {@link import('../audit/index.js').AuditEvent} ports the manager depends on
 * are likewise NOT re-exported here — they are owned by the Audit_Service barrel
 * (`./audit/index.js`) and re-exporting them would duplicate that export.
 */

export {
  BudgetManager,
  validateBudgetConfig,
  type BudgetManagerOptions,
  type BudgetIdGenerator,
  type RecordUsageResult,
} from './budget-manager.js';

export { periodWindow, dayWindow } from './period.js';

export {
  InvalidBudgetConfigError,
  quotaExceededError,
  INVALID_BUDGET_CONFIG_CODE,
  BUDGET_QUOTA_EXCEEDED_CODE,
} from './errors.js';

export {
  organizationScope,
  teamScope,
  projectScope,
  userScope,
  systemBudgetClock,
  BUDGET_SCOPE_LEVELS,
  BUDGET_PERIODS,
  BUDGET_STATUS_LEVELS,
  type BudgetScopeLevel,
  type BudgetScope,
  type BudgetPeriod,
  type BudgetConfig,
  type BudgetRecord,
  type UsageRecord,
  type RecordUsageInput,
  type PeriodWindow,
  type BudgetStatusLevel,
  type BudgetEvaluation,
  type BudgetDecisionKind,
  type BudgetDecision,
  type BillableRequest,
  type BudgetClock,
  type BudgetStore,
  type UsageQuery,
  type UsageStore,
  type BudgetAlert,
  type BudgetAlertNotifier,
} from './types.js';
