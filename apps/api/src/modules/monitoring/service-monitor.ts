/**
 * Per-service monitor binding a backend service name to the platform's shared
 * {@link MonitoringService} (Req 39.8, 42.8, 42.9, 46.6, 46.7).
 *
 * Each backend service in the platform — the REST_API, the Auth_Service, the
 * Model_Router, the Knowledge_Ingestion service, the WebSocket_Gateway, and so
 * on — exposes its own health-check and readiness endpoints (Req 39.8, 46.6).
 * They share one observability composition (one {@link LogSink}, one
 * {@link Tracer}, one {@link AlertDispatcher}, one {@link MetricStore}) so logs
 * and traces correlate across services on a single id (Req 46.7), while each
 * service tracks its own probes through this {@link CoreServiceMonitor} so its
 * health-check endpoint reports ONLY that service's probes.
 *
 * The adapter:
 *   - holds the service's OWN {@link HealthCheck} arrays (so a sibling
 *     service's unhealthy probe never bleeds into this service's report); and
 *   - aggregates each report through the core pure helpers
 *     {@link aggregateOutcomes} (worst-status-wins, Req 46.6) and
 *     {@link isReady} (the readiness gate, Req 46.6) so the aggregation logic
 *     lives in exactly one place.
 *
 * A probe that throws is treated as `unhealthy` rather than failing the report
 * so a per-service health-check endpoint always answers (Req 46.6).
 */

import {
  aggregateOutcomes,
  isReady,
  systemMonitoringClock,
  type HealthCheck,
  type HealthCheckOutcome,
  type HealthReport,
  type MonitoringClock,
  type MonitoringService,
  type ReadinessReport,
} from '@auxify/core';

import type { ServiceMonitor } from './types';

/**
 * A {@link ServiceMonitor} that binds a service name to the platform's shared
 * {@link MonitoringService} and tracks ITS OWN probes.
 *
 * The probes registered via {@link CoreServiceMonitor.registerHealthCheck} and
 * {@link CoreServiceMonitor.registerReadinessCheck} live on this monitor, NOT
 * on the shared {@link MonitoringService} — so {@link CoreServiceMonitor.health}
 * reports only THIS service's probes (a sibling's unhealthy probe never bleeds
 * into this service's report).
 */
export class CoreServiceMonitor implements ServiceMonitor {
  readonly serviceName: string;
  readonly monitoring: MonitoringService;
  private readonly clock: MonitoringClock;
  private readonly healthChecks: HealthCheck[] = [];
  private readonly readinessChecks: HealthCheck[] = [];

  constructor(
    serviceName: string,
    monitoring: MonitoringService,
    clock: MonitoringClock = systemMonitoringClock,
  ) {
    this.serviceName = serviceName;
    this.monitoring = monitoring;
    this.clock = clock;
  }

  /**
   * Register a liveness probe scoped to this service (Req 46.6).
   *
   * @param check The probe to add to this service's health report.
   */
  registerHealthCheck(check: HealthCheck): void {
    this.healthChecks.push(check);
  }

  /**
   * Register a readiness probe scoped to this service (Req 46.6).
   *
   * @param check The probe to add to this service's readiness report.
   */
  registerReadinessCheck(check: HealthCheck): void {
    this.readinessChecks.push(check);
  }

  /**
   * Build the aggregate liveness report for this service (Req 46.6, 39.8).
   *
   * The status is worst-status-wins across this service's probes (the core
   * pure {@link aggregateOutcomes}); a thrown probe resolves to `unhealthy`
   * rather than failing the report so the endpoint always answers.
   */
  async health(): Promise<HealthReport> {
    const checks = await this.runChecks(this.healthChecks);
    return {
      service: this.serviceName,
      status: aggregateOutcomes(checks),
      checks,
      checkedAtMs: this.clock.now(),
    };
  }

  /**
   * Build the aggregate readiness report for this service (Req 46.6, 39.8).
   *
   * The service is ready iff every readiness probe is `healthy` (the core pure
   * {@link isReady}); the report's `status` is the same worst-status-wins
   * aggregate as {@link health}.
   */
  async readiness(): Promise<ReadinessReport> {
    const checks = await this.runChecks(this.readinessChecks);
    return {
      service: this.serviceName,
      ready: isReady(checks),
      status: aggregateOutcomes(checks),
      checks,
      checkedAtMs: this.clock.now(),
    };
  }

  /**
   * Run a set of probes, mapping a thrown probe to an `unhealthy` outcome
   * (Req 46.6).
   */
  private async runChecks(checks: readonly HealthCheck[]): Promise<HealthCheckOutcome[]> {
    return Promise.all(
      checks.map(async (check): Promise<HealthCheckOutcome> => {
        try {
          const result = await check.check();
          const outcome: HealthCheckOutcome = { name: check.name, status: result.status };
          if (result.detail !== undefined) {
            outcome.detail = result.detail;
          }
          return outcome;
        } catch {
          return { name: check.name, status: 'unhealthy', detail: 'health check threw' };
        }
      }),
    );
  }
}
