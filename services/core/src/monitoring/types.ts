/**
 * Monitoring_Service domain types and injectable ports (Req 42.8, 42.9, 46.6,
 * 46.7, 39.8).
 *
 * The Monitoring_Service is the platform's observability seam. It collects the
 * four metric categories — system, application, business, and AI (Req 42.8); it
 * emits structured, JSON-serializable, secret-free logs carrying a correlation
 * identifier that traces a request across services (Req 46.7); it records
 * distributed-tracing spans tied to that same trace/correlation id (Req 42.8);
 * it dispatches an alert through a configured channel when a monitored metric
 * crosses its threshold (Req 42.9); and it produces the per-service health-check
 * and readiness reports the REST_API exposes as health/readiness endpoints
 * (Req 46.6, 39.8).
 *
 * Everything the service cannot do purely is a narrow injectable port so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`:
 *
 *   - a {@link LogSink} — where each {@link StructuredLogEntry} is emitted
 *     (production wires a JSON log shipper; tests capture the entries);
 *   - a {@link Tracer} — where each finished {@link TraceSpan} is recorded
 *     (production wires an OpenTelemetry-style exporter; tests record them);
 *   - an {@link AlertDispatcher} — where a fired {@link Alert} is sent through
 *     its channel (production wires Slack/email/PagerDuty; tests capture them);
 *   - an optional {@link MetricStore} — where each {@link MetricPoint} is
 *     persisted for aggregation (production wires a time-series store; tests use
 *     an in-memory store);
 *   - a {@link HealthCheck} registry — the per-service liveness/readiness probes;
 *   - a {@link MonitoringClock} — so timestamps and span durations are
 *     deterministic in tests.
 *
 * SECURITY: logs and traces are secret-free (Req 34.7 discipline). A token,
 * password, or secret-store value is NEVER placed in a log message, a log
 * field, or a span attribute — secrets are referenced by name only.
 *
 * Integrates with the platform-wide {@link import('@auxify/types').PlatformError}
 * (Req 46.8), whose `correlationId` (Req 46.7) is the same identifier a
 * {@link StructuredLogEntry} and a {@link TraceSpan} carry, so an error, its
 * logs, and its trace share one id end to end.
 */

/**
 * The category of a collected {@link MetricPoint} (Req 42.8).
 *
 * The Monitoring_Service collects four kinds of signal:
 * - `system` — host/runtime resources (CPU, memory, disk, network);
 * - `application` — request rates, latencies, error counts per service;
 * - `business` — product KPIs (active organizations, messages sent, documents);
 * - `ai` — model usage, token counts, inference latency, and cost.
 */
export type MetricCategory = 'system' | 'application' | 'business' | 'ai';

/** All {@link MetricCategory} values, for iteration, validation, and test generators. */
export const METRIC_CATEGORIES: readonly MetricCategory[] = [
  'system',
  'application',
  'business',
  'ai',
] as const;

/** Narrow runtime guard that a value is a supported {@link MetricCategory}. */
export function isMetricCategory(value: unknown): value is MetricCategory {
  return typeof value === 'string' && (METRIC_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A single collected metric observation across one of the four
 * {@link MetricCategory} dimensions (Req 42.8).
 *
 * A point names the metric ({@link name}), its category, the observed
 * {@link value}, an optional {@link unit} (e.g. `ms`, `bytes`, `count`,
 * `usd`), optional {@link labels} (secret-free dimensions such as `service` or
 * `model`), and the instant it was observed ({@link timestampMs}).
 */
export interface MetricPoint {
  /** The metric's stable name, e.g. `http.request.latency` or `ai.tokens.total`. */
  name: string;
  /** Which of the four collected categories the metric belongs to (Req 42.8). */
  category: MetricCategory;
  /** The observed numeric value. */
  value: number;
  /** Optional unit, e.g. `ms`, `bytes`, `count`, `usd`. */
  unit?: string;
  /** Optional secret-free dimensions, e.g. `{ service: 'rest-api', model: 'gpt' }`. */
  labels?: Record<string, string>;
  /** The instant the metric was observed, in epoch milliseconds. */
  timestampMs: number;
}

/**
 * The severity level of a {@link StructuredLogEntry}.
 *
 * Ordered least-to-most severe: `debug` < `info` < `warn` < `error`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** All {@link LogLevel} values, least-to-most severe, for iteration and test generators. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;

/**
 * A structured, JSON-serializable log entry carrying a correlation identifier
 * that traces a request across services (Req 46.7).
 *
 * Every entry carries the {@link correlationId} so the same request's logs can
 * be stitched together across the REST_API, the WebSocket_Gateway, and every
 * backend service — the same id a {@link import('@auxify/types').PlatformError}
 * and a {@link TraceSpan} carry. Optional {@link traceId}/{@link spanId} tie a
 * log line to a specific distributed-tracing span.
 *
 * SECURITY: the entry is secret-free. The {@link message} and {@link fields}
 * must never contain a token, password, or secret-store value — reference
 * secrets by name only (Req 34.7).
 */
export interface StructuredLogEntry {
  /** The severity level. */
  level: LogLevel;
  /** The human-readable, secret-free log message. */
  message: string;
  /** The correlation id tying this line to a request across services (Req 46.7). */
  correlationId: string;
  /** The instant the entry was emitted, in epoch milliseconds. */
  timestampMs: number;
  /** Optional structured, JSON-serializable, secret-free context fields. */
  fields?: Record<string, unknown>;
  /** Optional emitting service name, e.g. `rest-api`. */
  service?: string;
  /** Optional distributed-trace id this line belongs to. */
  traceId?: string;
  /** Optional span id this line belongs to. */
  spanId?: string;
}

/**
 * The seam each {@link StructuredLogEntry} is emitted through (Req 46.7).
 *
 * Production wires a JSON log shipper (stdout collector, a log aggregator);
 * tests substitute the capturing fake in `./fakes.js`. The Monitoring_Service
 * calls {@link emit} fail-soft: a sink that throws never propagates out of a
 * `log` call, because losing observability must not break the request it
 * observes.
 */
export interface LogSink {
  /**
   * Emit one structured log entry.
   *
   * @param entry The JSON-serializable, secret-free entry to record.
   */
  emit(entry: StructuredLogEntry): void;
}

/**
 * A single distributed-tracing span (Req 42.8).
 *
 * A span names a unit of work ({@link name}) within a service ({@link service}),
 * belongs to a trace ({@link traceId}) shared by every span of one request, and
 * optionally nests under a {@link parentSpanId}. {@link startMs} is the instant
 * it began and {@link endMs} the instant it finished (absent while in flight);
 * the duration is {@link endMs} − {@link startMs} and is never negative when
 * timed by a single {@link MonitoringClock}.
 */
export interface TraceSpan {
  /** The trace this span belongs to — shared by every span of one request. */
  traceId: string;
  /** This span's unique id within its trace. */
  spanId: string;
  /** The enclosing span's id, when this span nests under another. */
  parentSpanId?: string;
  /** The unit of work the span measures, e.g. `chat.send` or `db.query`. */
  name: string;
  /** The service the span ran in, e.g. `rest-api`. */
  service: string;
  /** The instant the span began, in epoch milliseconds. */
  startMs: number;
  /** The instant the span finished, in epoch milliseconds; absent while in flight. */
  endMs?: number;
  /** Optional secret-free span attributes. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * The context a {@link TraceSpan} is started from — the trace/correlation
 * identity it inherits (Req 42.8, 46.7).
 *
 * A span ties to a request through its {@link correlationId}; its
 * {@link traceId} defaults to that correlation id when not supplied, so a log
 * line and a span sharing a correlation id sit in the same trace. A
 * {@link parentSpanId} nests the new span under an enclosing one.
 */
export interface SpanContext {
  /** The correlation id of the request the span serves (Req 46.7). */
  correlationId: string;
  /** The trace id; defaults to {@link correlationId} when omitted. */
  traceId?: string;
  /** The enclosing span's id, when nesting. */
  parentSpanId?: string;
  /** The service the span runs in; defaults to the service the entry was made for. */
  service?: string;
  /** Optional secret-free span attributes. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * The seam each finished {@link TraceSpan} is recorded through (Req 42.8).
 *
 * Production wires an OpenTelemetry-style span exporter; tests substitute the
 * recording fake in `./fakes.js`. Called fail-soft: a recorder that throws
 * never propagates out of an `endSpan` call.
 */
export interface Tracer {
  /**
   * Record one finished span.
   *
   * @param span The completed span (its {@link TraceSpan.endMs} is set).
   */
  record(span: TraceSpan): void;
}

/**
 * The comparison an {@link AlertThreshold} applies to a metric's observed value.
 *
 * - `gt` / `gte` — fire when the observed value is above (or at-or-above) the
 *   threshold (an upper bound, e.g. error rate);
 * - `lt` / `lte` — fire when it is below (or at-or-below) the threshold (a lower
 *   bound, e.g. available disk).
 */
export type ThresholdComparison = 'gt' | 'gte' | 'lt' | 'lte';

/** All {@link ThresholdComparison} values, for iteration and test generators. */
export const THRESHOLD_COMPARISONS: readonly ThresholdComparison[] = [
  'gt',
  'gte',
  'lt',
  'lte',
] as const;

/**
 * The channel an {@link Alert} is dispatched through (Req 42.9).
 *
 * An opaque, non-secret channel identifier the {@link AlertDispatcher} resolves
 * to a concrete destination (a Slack webhook, an email distribution list, a
 * PagerDuty service). The identifier itself is never a secret.
 */
export type AlertChannel = string;

/**
 * A configured alerting rule for a metric (Req 42.9).
 *
 * When a recorded {@link MetricPoint} named {@link metricName} crosses
 * {@link value} under {@link comparison}, the Monitoring_Service dispatches an
 * {@link Alert} through {@link channel}.
 */
export interface AlertThreshold {
  /** The metric name this threshold watches. */
  metricName: string;
  /** How the observed value is compared to {@link value}. */
  comparison: ThresholdComparison;
  /** The threshold value the observed value is compared against. */
  value: number;
  /** The channel an alert is dispatched through when the threshold is crossed. */
  channel: AlertChannel;
}

/**
 * An alert fired when a monitored metric crossed its {@link AlertThreshold}
 * (Req 42.9).
 *
 * Carries the metric that breached, the value that breached it, the threshold
 * that was crossed, the channel it is dispatched through, and the instant it
 * fired — all secret-free.
 */
export interface Alert {
  /** The metric name whose threshold was crossed. */
  thresholdMetric: string;
  /** The observed value that crossed the threshold. */
  observedValue: number;
  /** The threshold that was crossed. */
  threshold: AlertThreshold;
  /** The channel the alert is dispatched through. */
  channel: AlertChannel;
  /** The instant the alert fired, in epoch milliseconds. */
  firedAtMs: number;
}

/**
 * The seam a fired {@link Alert} is dispatched through (Req 42.9).
 *
 * Production wires the concrete channels — Slack, email, PagerDuty; tests
 * substitute the capturing fake in `./fakes.js`. Called fail-soft: a dispatcher
 * that throws never propagates out of a metric recording, because a failed
 * alert delivery must not break the work that produced the metric.
 */
export interface AlertDispatcher {
  /**
   * Dispatch one alert through its configured channel.
   *
   * @param alert The fired alert to deliver.
   */
  dispatch(alert: Alert): void | Promise<void>;
}

/**
 * The optional sink each collected {@link MetricPoint} is persisted to for
 * aggregation (Req 42.8).
 *
 * Production wires a time-series store; tests substitute the in-memory store in
 * `./fakes.js`. When no store is configured the Monitoring_Service still
 * evaluates thresholds and dispatches alerts — persistence is independent of
 * alerting.
 */
export interface MetricStore {
  /**
   * Persist one collected metric.
   *
   * @param point The observed metric to store.
   */
  record(point: MetricPoint): void;
}

/**
 * The health of a single {@link HealthCheck} or the aggregate of a service
 * (Req 46.6).
 *
 * Ordered worst-to-best for aggregation: `unhealthy` < `degraded` < `healthy`.
 * An aggregate is the worst status across its checks (worst-status-wins).
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** All {@link HealthStatus} values, worst-to-best, for iteration and test generators. */
export const HEALTH_STATUSES: readonly HealthStatus[] = [
  'unhealthy',
  'degraded',
  'healthy',
] as const;

/**
 * The result of running a single {@link HealthCheck} (Req 46.6).
 *
 * A {@link status} plus an optional secret-free {@link detail} describing why
 * (e.g. `"primary database unreachable"`).
 */
export interface HealthCheckResult {
  /** The check's health status. */
  status: HealthStatus;
  /** An optional secret-free explanation. */
  detail?: string;
}

/**
 * A single named health probe for a service (Req 46.6, 39.8).
 *
 * Production probes a real dependency (the Primary_Database, the Vector_Store,
 * a downstream service); tests substitute the healthy/unhealthy stubs in
 * `./fakes.js`. A probe that throws is treated as `unhealthy` by the
 * Monitoring_Service rather than propagating, so a health endpoint always
 * answers.
 */
export interface HealthCheck {
  /** The probe's stable name, e.g. `database` or `vector_store`. */
  name: string;
  /**
   * Run the probe and report its health.
   *
   * @returns The probe's {@link HealthCheckResult}.
   */
  check(): Promise<HealthCheckResult>;
}

/**
 * The outcome of one {@link HealthCheck} as it appears in a {@link HealthReport}
 * or {@link ReadinessReport} — the probe's name plus its resolved status.
 */
export interface HealthCheckOutcome {
  /** The probe's name. */
  name: string;
  /** The probe's resolved status (a thrown probe resolves to `unhealthy`). */
  status: HealthStatus;
  /** An optional secret-free explanation. */
  detail?: string;
}

/**
 * The aggregate liveness/health of a service (Req 46.6, 39.8).
 *
 * The {@link status} is the worst status across {@link checks}
 * (worst-status-wins): `unhealthy` if any check is unhealthy, else `degraded` if
 * any is degraded, else `healthy`. This is the report a per-service
 * health-check endpoint returns.
 */
export interface HealthReport {
  /** The service the report describes. */
  service: string;
  /** The aggregate health (worst across {@link checks}). */
  status: HealthStatus;
  /** The per-probe outcomes. */
  checks: HealthCheckOutcome[];
  /** The instant the report was produced, in epoch milliseconds. */
  checkedAtMs: number;
}

/**
 * The readiness of a service to receive traffic (Req 46.6, 39.8).
 *
 * A service is {@link ready} iff every readiness check is `healthy`; the
 * {@link status} is the same worst-status-wins aggregate as a
 * {@link HealthReport}. This is the report a per-service readiness endpoint
 * returns.
 */
export interface ReadinessReport {
  /** The service the report describes. */
  service: string;
  /** Whether every readiness check passed (`healthy`) — the readiness gate. */
  ready: boolean;
  /** The aggregate status (worst across {@link checks}). */
  status: HealthStatus;
  /** The per-probe outcomes. */
  checks: HealthCheckOutcome[];
  /** The instant the report was produced, in epoch milliseconds. */
  checkedAtMs: number;
}

/**
 * The injectable clock the Monitoring_Service reads for log/alert timestamps
 * and span durations.
 *
 * Injectable so unit tests fix and advance "now" deterministically — a span's
 * duration is exactly the clock delta between {@link MonitoringService.startSpan}
 * and {@link MonitoringService.endSpan}. Named {@link MonitoringClock} (not
 * `Clock`) so it never collides with the Model_Router's, Scheduler's,
 * Backup_Service's, or any sibling's identically-purposed clock in the shared
 * `@auxify/core` barrel.
 */
export interface MonitoringClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link MonitoringClock}, backed by the global `Date.now`. */
export const systemMonitoringClock: MonitoringClock = { now: () => Date.now() };
