/**
 * Monitoring_Service (Req 42.8, 42.9, 46.6, 46.7, 39.8): the platform's
 * observability service — metric collection, structured correlated logging,
 * distributed tracing, threshold alerting, and per-service health/readiness.
 *
 * The {@link MonitoringService} collects the four metric categories — system,
 * application, business, and AI (Req 42.8, {@link MonitoringService.recordMetric}
 * / {@link MonitoringService.recordMetrics}); on each collected
 * {@link MetricPoint} it evaluates every configured {@link AlertThreshold} for
 * that metric (via the pure {@link thresholdBreached}) and dispatches an
 * {@link Alert} through the threshold's channel when it is crossed (Req 42.9);
 * it emits structured, JSON-serializable, secret-free {@link StructuredLogEntry}
 * logs carrying a correlation identifier that traces a request across services
 * ({@link MonitoringService.log} / {@link MonitoringService.logger}, Req 46.7,
 * normalized by {@link toSerializableEntry}); it records distributed-tracing
 * {@link TraceSpan}s tied to that same trace/correlation id
 * ({@link MonitoringService.startSpan} / {@link MonitoringService.endSpan},
 * Req 42.8); and it produces the per-service {@link HealthReport} and
 * {@link ReadinessReport} the REST_API exposes as health-check and readiness
 * endpoints — liveness is the worst-status-wins aggregate of the registered
 * checks and readiness gates on every readiness check being healthy
 * ({@link MonitoringService.health} / {@link MonitoringService.readiness} over
 * the pure {@link aggregateStatus} / {@link aggregateOutcomes} / {@link isReady}
 * core, Req 46.6, 39.8). The HTTP wiring of those endpoints is the REST_API's
 * job; this module exposes the report-producing methods.
 *
 * Every external capability is a narrow injectable port — a {@link LogSink}, an
 * optional {@link Tracer}, an {@link AlertDispatcher}, an optional
 * {@link MetricStore}, a {@link HealthCheck} registry, and a
 * {@link MonitoringClock} — so the service is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./fakes.js`. It is fail-soft:
 * losing observability never breaks the observed work — a throwing
 * sink/tracer/dispatcher is swallowed and a throwing health probe resolves to
 * `unhealthy`.
 *
 * SECURITY: logs and traces are secret-free (Req 34.7 discipline). A token,
 * password, or secret-store value is never placed in a log message/field or a
 * span attribute — secrets are referenced by name only.
 *
 * Integrates with the platform-wide {@link import('@auxify/types').PlatformError}
 * (Req 46.8): a `PlatformError`'s `correlationId` (Req 46.7) is the same id a
 * {@link StructuredLogEntry} and a {@link TraceSpan} carry, so an error, its
 * logs, and its trace share one identifier end to end.
 *
 * The in-memory test fakes (a capturing log sink, a recording tracer, a
 * capturing alert dispatcher, an in-memory metric store, the advanceable
 * {@link MutableMonitoringClock}, and the health-check builders) live in
 * `./fakes.js` and are intentionally NOT re-exported from this barrel — they
 * would collide with the equally-named capturing fakes of sibling modules at the
 * package barrel. Following the established convention, the tests import them
 * directly from `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link MonitoringClock} /
 * {@link systemMonitoringClock} (rather than `Clock` / `systemClock`) so the
 * names never collide with the Model_Router's, Scheduler's, Backup_Service's, or
 * any sibling's identically-purposed clock in the shared `@auxify/core` barrel.
 */

export {
  MonitoringService,
  thresholdBreached,
  toSerializableEntry,
  type MonitoringServiceOptions,
  type SpanIdGenerator,
  type CorrelatedLogger,
} from './monitoring-service.js';

export { aggregateStatus, aggregateOutcomes, isReady } from './health.js';

export {
  systemMonitoringClock,
  METRIC_CATEGORIES,
  LOG_LEVELS,
  THRESHOLD_COMPARISONS,
  HEALTH_STATUSES,
  isMetricCategory,
  type MetricCategory,
  type MetricPoint,
  type MetricStore,
  type LogLevel,
  type StructuredLogEntry,
  type LogSink,
  type TraceSpan,
  type SpanContext,
  type Tracer,
  type ThresholdComparison,
  type AlertChannel,
  type AlertThreshold,
  type Alert,
  type AlertDispatcher,
  type HealthStatus,
  type HealthCheckResult,
  type HealthCheck,
  type HealthCheckOutcome,
  type HealthReport,
  type ReadinessReport,
  type MonitoringClock,
} from './types.js';
