/**
 * Test fakes for the Budget_Manager (Req 22.1-22.6).
 *
 * The only things the Budget_Manager cannot do purely are reading time,
 * persisting budgets and usage, recording audit events, and notifying an
 * administrator — so those are exactly what these fakes stand in for.
 * Everything here is deterministic and in-memory; nothing touches a real timer,
 * a database, or a notification channel:
 *
 *  - {@link MutableBudgetClock} — a hand-advanced {@link BudgetClock} so a test
 *    can fix "now", place spend in a specific period, and advance across a
 *    period boundary to assert the reset (Req 22.3-22.5).
 *  - {@link InMemoryBudgetStore} — an in-memory {@link BudgetStore} keyed by
 *    `(organizationId, level, refId)`, so budgets are isolated per Organization
 *    (Req 1.4).
 *  - {@link InMemoryUsageStore} — an append-only {@link UsageStore} that lists
 *    records by scope and time window, matching the attribution column for the
 *    queried level (Req 22.1, 22.6).
 *  - {@link CapturingAuditRecorder} — captures every recorded `(ctx, event)` so
 *    a test can assert which budget mutations and crossings were audited
 *    (Req 37.2).
 *  - {@link RecordingAlertNotifier} — captures every out-of-band alert delivery
 *    (Req 22.2).
 *  - {@link sequentialBudgetIdGenerator} — hands out `usage-1`, `usage-2`, … for
 *    assertion-friendly tests.
 *
 * Tests import these fakes directly from `./fakes.js`, never from a package
 * barrel.
 */

import type { TenantContext } from '@auxify/types';

import type { BudgetIdGenerator } from './budget-manager.js';
import type {
  AuditEvent,
  AuditRecorder,
  BudgetAlert,
  BudgetAlertNotifier,
  BudgetClock,
  BudgetRecord,
  BudgetScopeLevel,
  UsageQuery,
  UsageRecord,
  UsageStore,
  BudgetStore,
} from './types.js';

/**
 * A hand-advanced {@link BudgetClock} for deterministic budget/period tests.
 *
 * Construct it at a fixed epoch-ms origin (default `0`); read "now" with
 * {@link MutableBudgetClock.now}; move time forward with
 * {@link MutableBudgetClock.advance} (milliseconds) or set it absolutely with
 * {@link MutableBudgetClock.set} / {@link MutableBudgetClock.setIso}.
 */
export class MutableBudgetClock implements BudgetClock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Set the clock to an absolute epoch-ms time. */
  set(ms: number): void {
    this.current = ms;
  }

  /** Set the clock to an absolute ISO-8601 instant. */
  setIso(iso: string): void {
    this.current = Date.parse(iso);
  }
}

/** Compose the composite key a budget is stored under within an Organization. */
function budgetKey(organizationId: string, level: BudgetScopeLevel, refId: string): string {
  return `${organizationId}\u0000${level}\u0000${refId}`;
}

/**
 * An in-memory {@link BudgetStore} keyed by `(organizationId, level, refId)`.
 *
 * Two Organizations that happen to use the same Team/Project/user id never
 * share a budget, so tenant isolation holds by construction (Req 1.4).
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly records = new Map<string, BudgetRecord>();

  async get(
    organizationId: string,
    level: BudgetScopeLevel,
    refId: string,
  ): Promise<BudgetRecord | null> {
    return this.records.get(budgetKey(organizationId, level, refId)) ?? null;
  }

  async set(record: BudgetRecord): Promise<void> {
    this.records.set(budgetKey(record.organizationId, record.level, record.refId), { ...record });
  }

  /** The number of budgets stored. */
  get size(): number {
    return this.records.size;
  }
}

/**
 * An append-only in-memory {@link UsageStore} (Req 22.1, 22.6).
 *
 * {@link list} matches the attribution column corresponding to the queried
 * level — `organizationId` / `teamId` / `projectId` / `userId` — within the
 * Organization and the half-open `[fromMs, toMs)` window, plus an optional model
 * filter (for the per-model daily-limit count, Req 22.5). Records are never
 * removed, mirroring the 2-year retention (Req 22.6).
 */
export class InMemoryUsageStore implements UsageStore {
  /** Every appended record, in order. */
  readonly records: UsageRecord[] = [];

  async append(record: UsageRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async list(query: UsageQuery): Promise<UsageRecord[]> {
    return this.records
      .filter((record) => {
        if (record.organizationId !== query.organizationId) {
          return false;
        }
        if (!matchesScope(record, query.level, query.refId)) {
          return false;
        }
        if (query.model !== undefined && record.model !== query.model) {
          return false;
        }
        const ms = Date.parse(record.createdAt);
        return ms >= query.fromMs && ms < query.toMs;
      })
      .map((record) => ({ ...record }));
  }
}

/** Does a usage record's attribution column for `level` equal `refId`? */
function matchesScope(record: UsageRecord, level: BudgetScopeLevel, refId: string): boolean {
  switch (level) {
    case 'organization':
      return record.organizationId === refId;
    case 'team':
      return record.teamId === refId;
    case 'project':
      return record.projectId === refId;
    case 'user':
      return record.userId === refId;
    default:
      return false;
  }
}

/** A captured audit event, with the tenant context it was recorded in. */
export interface CapturedBudgetAudit {
  /** The tenant context the event was scoped to. */
  ctx: TenantContext;
  /** The recorded event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded `(ctx, event)`
 * so a test can assert which budget mutations and crossings were audited
 * (Req 37.2), mirroring the capturing recorders used by sibling modules.
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedBudgetAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({ ctx, event });
  }

  /** The number of recorded events. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `budget.cap_reached`). */
  withAction(action: string): CapturedBudgetAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/** A captured out-of-band alert delivery, with the tenant context it occurred in. */
export interface CapturedAlert {
  /** The tenant context the spend occurred in. */
  ctx: TenantContext;
  /** The delivered alert. */
  alert: BudgetAlert;
}

/**
 * A {@link BudgetAlertNotifier} that records every delivered alert so a test can
 * assert the responsible administrator was notified on a threshold/cap crossing
 * (Req 22.2).
 */
export class RecordingAlertNotifier implements BudgetAlertNotifier {
  /** Every delivered alert, in order, with the context it occurred in. */
  readonly notifications: CapturedAlert[] = [];

  async notify(ctx: TenantContext, alert: BudgetAlert): Promise<void> {
    this.notifications.push({ ctx, alert });
  }

  /** Every delivered alert of the given kind. */
  ofKind(kind: BudgetAlert['kind']): CapturedAlert[] {
    return this.notifications.filter((n) => n.alert.kind === kind);
  }
}

/**
 * A deterministic {@link BudgetIdGenerator} handing out `usage-1`, `usage-2`, …
 * usage-record ids, for assertion-friendly tests.
 */
export function sequentialBudgetIdGenerator(): BudgetIdGenerator {
  let counter = 0;
  return {
    usageId: () => {
      counter += 1;
      return `usage-${counter}`;
    },
  };
}
