/**
 * Pure health/readiness aggregation core for the Monitoring_Service (Req 46.6,
 * 39.8).
 *
 * These functions are total and side-effect-free: given the resolved per-probe
 * outcomes they compute the worst-status-wins aggregate and the readiness gate.
 * Running the probes (and treating a thrown probe as `unhealthy`) is the
 * {@link import('./monitoring-service.js').MonitoringService}'s concern; here we
 * only fold their results, so the aggregation is trivially unit-testable.
 */

import type { HealthCheckOutcome, HealthStatus } from './types.js';

/**
 * The severity rank of a {@link HealthStatus} — lower is worse — used to fold a
 * set of statuses to their worst (Req 46.6).
 */
const STATUS_SEVERITY: Readonly<Record<HealthStatus, number>> = {
  unhealthy: 0,
  degraded: 1,
  healthy: 2,
};

/**
 * Aggregate a set of per-probe statuses to the worst one (worst-status-wins,
 * Req 46.6).
 *
 * An empty set is `healthy` (no probe reported a problem): a service with no
 * registered checks is live. Otherwise the result is `unhealthy` if any probe
 * is unhealthy, else `degraded` if any is degraded, else `healthy`.
 *
 * @param statuses The resolved per-probe statuses.
 * @returns The worst status across `statuses`, or `healthy` when empty.
 */
export function aggregateStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'healthy';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] < STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }
  return worst;
}

/**
 * Aggregate a set of probe {@link HealthCheckOutcome}s to their worst status
 * (Req 46.6).
 *
 * @param outcomes The resolved per-probe outcomes.
 * @returns The worst status across the outcomes, or `healthy` when empty.
 */
export function aggregateOutcomes(outcomes: readonly HealthCheckOutcome[]): HealthStatus {
  return aggregateStatus(outcomes.map((outcome) => outcome.status));
}

/**
 * The readiness gate: a service is ready iff EVERY readiness probe is `healthy`
 * (Req 46.6).
 *
 * A single `degraded` or `unhealthy` readiness probe withholds traffic; an
 * empty set is ready (nothing blocks readiness).
 *
 * @param outcomes The resolved readiness-probe outcomes.
 * @returns `true` iff every outcome is `healthy`.
 */
export function isReady(outcomes: readonly HealthCheckOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.status === 'healthy');
}
