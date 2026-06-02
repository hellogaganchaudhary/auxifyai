/**
 * The Monitoring_Service (Req 42.8, 42.9, 46.6, 46.7, 39.8).
 *
 * The platform's observability composition. It collects the four metric
 * categories — system, application, business, and AI (Req 42.8); emits
 * structured, JSON-serializable, secret-free logs carrying a correlation
 * identifier that traces a request across services (Req 46.7); records
 * distributed-tracing spans tied to that same trace/correlation id (Req 42.8);
 * dispatches an alert through a configured channel when a recorded metric
 * crosses its threshold (Req 42.9); and produces the per-service health and
 * readiness reports the REST_API exposes as health/readiness endpoints
 * (Req 46.6, 39.8).
 *
 * It is pure orchestration over injectable ports — a {@link LogSink}, an
 * optional {@link Tracer}, an {@link AlertDispatcher}, an optional
 * {@link MetricStore}, a {@link HealthCheck} registry, and a
 * {@link MonitoringClock} — so it is fully unit-testable with the in-memory
 * fakes in `./fakes.js`.
 *
 * Fail-soft: losing observability must never break the work being observed.
 * {@link MonitoringService.log}, {@link MonitoringService.endSpan}, and the
 * alert dispatch on {@link MonitoringService.recordMetric} swallow a port's
 * failure rather than propagating it; a {@link HealthCheck} that throws resolves
 * to `unhealthy` rather than failing the report.
 *
 * SECURITY: logs and traces are secret-free (Req 34.7 discipline). Callers must
 * never pass a token, password, or secret-store value into a log message/field
 * or a span attribute — secrets are referenced by name only.
 */

import { aggregateOutcomes, isReady } from './health.js';
import {
  systemMonitoringClock,
  type Alert,
  type AlertDispatcher,
  type AlertThreshold,
  type HealthCheck,
  type HealthCheckOutcome,
  type HealthReport,
  type LogLevel,
  type LogSink,
  type MetricPoint,
  type MetricStore,
  type MonitoringClock,
  type ReadinessReport,
  type SpanContext,
  type StructuredLogEntry,
  type ThresholdComparison,
  type Tracer,
  type TraceSpan,
} from './types.js';

/**
 * Generates unique span ids (injectable for deterministic tests).
 */
export interface SpanIdGenerator {
  /** A unique span id. */
  spanId(): string;
}

/** Default span-id generator backed by `crypto.randomUUID`. */
const defaultSpanIdGenerator: SpanIdGenerator = {
  spanId: () => globalThis.crypto.randomUUID(),
};

/**
 * The level-stamping logger a caller obtains from
 * {@link MonitoringService.logger}, with the correlation id (and optional
 * service) bound once so every line it emits is correlated automatically
 * (Req 46.7).
 */
export interface CorrelatedLogger {
  /** Emit a `debug`-level entry under the bound correlation id. */
  debug(message: string, fields?: Record<string, unknown>): void;
  /** Emit an `info`-level entry under the bound correlation id. */
  info(message: string, fields?: Record<string, unknown>): void;
  /** Emit a `warn`-level entry under the bound correlation id. */
  warn(message: string, fields?: Record<string, unknown>): void;
  /** Emit an `error`-level entry under the bound correlation id. */
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Construction options for the {@link MonitoringService}. */
export interface MonitoringServiceOptions {
  /** The sink structured log entries are emitted through (Req 46.7). */
  logSink: LogSink;
  /** The dispatcher fired alerts are sent through (Req 42.9). */
  alertDispatcher: AlertDispatcher;
  /** Optional tracer finished spans are recorded through (Req 42.8). */
  tracer?: Tracer;
  /** Optional store collected metrics are persisted to (Req 42.8). */
  metricStore?: MetricStore;
  /** Optional initial alert thresholds (Req 42.9); more can be added via {@link MonitoringService.setThreshold}. */
  thresholds?: readonly AlertThreshold[];
  /** Optional clock for "now" (defaults to {@link systemMonitoringClock}), for deterministic tests. */
  clock?: MonitoringClock;
  /** Optional span-id generator (defaults to `crypto.randomUUID`). */
  spanIdGenerator?: SpanIdGenerator;
}

/**
 * The Monitoring_Service: collects metrics, emits correlated structured logs,
 * records distributed traces, dispatches threshold alerts, and produces
 * per-service health/readiness reports (Req 42.8, 42.9, 46.6, 46.7, 39.8).
 */
export class MonitoringService {
  private readonly logSink: LogSink;
  private readonly alertDispatcher: AlertDispatcher;
  private readonly tracer: Tracer | undefined;
  private readonly metricStore: MetricStore | undefined;
  private readonly clock: MonitoringClock;
  private readonly spanIds: SpanIdGenerator;
  /** All configured thresholds, indexed by the metric name they watch (Req 42.9). */
  private readonly thresholds = new Map<string, AlertThreshold[]>();
  /** The registered liveness/health probes (Req 46.6). */
  private readonly healthChecks: HealthCheck[] = [];
  /** The registered readiness probes (Req 46.6). */
  private readonly readinessChecks: HealthCheck[] = [];

  constructor(options: MonitoringServiceOptions) {
    this.logSink = options.logSink;
    this.alertDispatcher = options.alertDispatcher;
    this.tracer = options.tracer;
    this.metricStore = options.metricStore;
    this.clock = options.clock ?? systemMonitoringClock;
    this.spanIds = options.spanIdGenerator ?? defaultSpanIdGenerator;
    for (const threshold of options.thresholds ?? []) {
      this.setThreshold(threshold);
    }
  }

  // --- metrics (Req 42.8, 42.9) ------------------------------------------

  /**
   * Collect one metric across any of the four {@link MetricCategory} dimensions
   * (Req 42.8) and evaluate every threshold configured for its name, dispatching
   * an {@link Alert} for each crossed threshold (Req 42.9).
   *
   * The metric is persisted to the {@link MetricStore} when one is configured.
   * Threshold evaluation is the pure {@link thresholdBreached}; alert dispatch
   * is fail-soft so a failing channel never breaks the work that produced the
   * metric.
   *
   * @param point The observed metric.
   * @returns The alerts that were fired for this metric, in threshold-registration order.
   */
  async recordMetric(point: MetricPoint): Promise<Alert[]> {
    if (this.metricStore !== undefined) {
      try {
        this.metricStore.record(point);
      } catch {
        // Fail-soft: a failed metric persist must not break the observed work.
      }
    }

    const fired: Alert[] = [];
    const watching = this.thresholds.get(point.name) ?? [];
    for (const threshold of watching) {
      if (thresholdBreached(threshold.comparison, point.value, threshold.value)) {
        const alert: Alert = {
          thresholdMetric: threshold.metricName,
          observedValue: point.value,
          threshold,
          channel: threshold.channel,
          firedAtMs: this.clock.now(),
        };
        await this.dispatchAlert(alert);
        fired.push(alert);
      }
    }
    return fired;
  }

  /**
   * Collect a batch of metrics, evaluating thresholds for each (Req 42.8, 42.9).
   *
   * @param points The observed metrics.
   * @returns Every alert fired across the batch, in order.
   */
  async recordMetrics(points: readonly MetricPoint[]): Promise<Alert[]> {
    const fired: Alert[] = [];
    for (const point of points) {
      fired.push(...(await this.recordMetric(point)));
    }
    return fired;
  }

  // --- alert thresholds (Req 42.9) ---------------------------------------

  /**
   * Register (add) an alert threshold for a metric (Req 42.9).
   *
   * Multiple thresholds may watch one metric name (e.g. a warning and a critical
   * bound); each is evaluated independently on every recorded metric.
   *
   * @param threshold The rule to register.
   */
  setThreshold(threshold: AlertThreshold): void {
    const existing = this.thresholds.get(threshold.metricName);
    if (existing === undefined) {
      this.thresholds.set(threshold.metricName, [{ ...threshold }]);
    } else {
      existing.push({ ...threshold });
    }
  }

  /**
   * Remove every threshold watching a metric name.
   *
   * @param metricName The metric whose thresholds to clear.
   * @returns `true` if any threshold was removed.
   */
  clearThresholds(metricName: string): boolean {
    return this.thresholds.delete(metricName);
  }

  /**
   * The thresholds currently watching a metric name (a copy), in registration
   * order.
   *
   * @param metricName The metric to inspect.
   * @returns The configured thresholds for `metricName`.
   */
  getThresholds(metricName: string): AlertThreshold[] {
    return (this.thresholds.get(metricName) ?? []).map((threshold) => ({ ...threshold }));
  }

  // --- structured logging (Req 46.7) -------------------------------------

  /**
   * Emit a structured, JSON-serializable log entry through the {@link LogSink}
   * (Req 46.7).
   *
   * The entry is normalized to a plain, JSON-serializable, secret-free object
   * ({@link toSerializableEntry}) — any non-JSON field value (a function, a
   * symbol, `undefined`) is dropped — before it is emitted, so the line is
   * always safe to ship. Fail-soft: a sink that throws never propagates.
   *
   * @param entry The structured entry to emit.
   * @returns The normalized entry that was emitted.
   */
  log(entry: StructuredLogEntry): StructuredLogEntry {
    const normalized = toSerializableEntry(entry);
    try {
      this.logSink.emit(normalized);
    } catch {
      // Fail-soft: losing a log line must not break the request it observes.
    }
    return normalized;
  }

  /**
   * Build a level-stamping logger that automatically stamps every line with the
   * given correlation id (and optional service), so callers cannot forget to
   * correlate their logs (Req 46.7).
   *
   * @param correlationId The correlation id to bind to every emitted line.
   * @param service Optional emitting service name.
   * @returns A {@link CorrelatedLogger} with `debug`/`info`/`warn`/`error` helpers.
   */
  logger(correlationId: string, service?: string): CorrelatedLogger {
    const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      const entry: StructuredLogEntry = {
        level,
        message,
        correlationId,
        timestampMs: this.clock.now(),
      };
      if (service !== undefined) {
        entry.service = service;
      }
      if (fields !== undefined) {
        entry.fields = fields;
      }
      this.log(entry);
    };
    return {
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
    };
  }

  // --- distributed tracing (Req 42.8) ------------------------------------

  /**
   * Begin a distributed-tracing span tied to a request's trace/correlation id
   * (Req 42.8).
   *
   * The span's {@link TraceSpan.traceId} defaults to the context's correlation
   * id when no explicit trace id is supplied, so a log line and a span sharing a
   * correlation id sit in the same trace. The returned span is in flight
   * ({@link TraceSpan.endMs} is unset) until passed to {@link endSpan}.
   *
   * @param name The unit of work the span measures.
   * @param ctx The trace/correlation context the span inherits.
   * @returns The started, in-flight span.
   */
  startSpan(name: string, ctx: SpanContext): TraceSpan {
    const span: TraceSpan = {
      traceId: ctx.traceId ?? ctx.correlationId,
      spanId: this.spanIds.spanId(),
      name,
      service: ctx.service ?? 'unknown',
      startMs: this.clock.now(),
    };
    if (ctx.parentSpanId !== undefined) {
      span.parentSpanId = ctx.parentSpanId;
    }
    if (ctx.attributes !== undefined) {
      span.attributes = { ...ctx.attributes };
    }
    return span;
  }

  /**
   * Finish a span started by {@link startSpan} and record it through the
   * {@link Tracer} (Req 42.8).
   *
   * Sets {@link TraceSpan.endMs} from the clock — never before its `startMs`, so
   * the duration is non-negative — and records the finished span. Fail-soft: a
   * tracer that throws never propagates; with no tracer configured the finished
   * span is simply returned.
   *
   * @param span The in-flight span to finish.
   * @param attributes Optional secret-free attributes to merge before recording.
   * @returns The finished span (with {@link TraceSpan.endMs} set).
   */
  endSpan(span: TraceSpan, attributes?: Record<string, string | number | boolean>): TraceSpan {
    const endMs = Math.max(span.startMs, this.clock.now());
    const finished: TraceSpan = { ...span, endMs };
    if (attributes !== undefined) {
      finished.attributes = { ...(span.attributes ?? {}), ...attributes };
    }
    if (this.tracer !== undefined) {
      try {
        this.tracer.record(finished);
      } catch {
        // Fail-soft: a failed span export must not break the work it traced.
      }
    }
    return finished;
  }

  // --- health & readiness (Req 46.6, 39.8) -------------------------------

  /**
   * Register a liveness/health probe for the service (Req 46.6).
   *
   * @param check The probe to add to the health report.
   */
  registerCheck(check: HealthCheck): void {
    this.healthChecks.push(check);
  }

  /**
   * Register a readiness probe for the service (Req 46.6).
   *
   * Readiness gates traffic: a service is ready iff every readiness probe is
   * `healthy`.
   *
   * @param check The probe to add to the readiness report.
   */
  registerReadinessCheck(check: HealthCheck): void {
    this.readinessChecks.push(check);
  }

  /**
   * Run the registered liveness probes and aggregate them into a
   * {@link HealthReport} — the backend of a per-service health-check endpoint
   * (Req 46.6, 39.8).
   *
   * The aggregate status is worst-status-wins across the probes; a probe that
   * throws resolves to `unhealthy` rather than failing the report, so the
   * endpoint always answers.
   *
   * @param service The service the report describes.
   * @returns The aggregate {@link HealthReport}.
   */
  async health(service: string): Promise<HealthReport> {
    const checks = await this.runChecks(this.healthChecks);
    return {
      service,
      status: aggregateOutcomes(checks),
      checks,
      checkedAtMs: this.clock.now(),
    };
  }

  /**
   * Run the registered readiness probes and aggregate them into a
   * {@link ReadinessReport} — the backend of a per-service readiness endpoint
   * (Req 46.6, 39.8).
   *
   * The service is ready iff EVERY readiness probe is `healthy` ({@link isReady});
   * the status is the same worst-status-wins aggregate as {@link health}.
   *
   * @param service The service the report describes.
   * @returns The {@link ReadinessReport}.
   */
  async readiness(service: string): Promise<ReadinessReport> {
    const checks = await this.runChecks(this.readinessChecks);
    return {
      service,
      ready: isReady(checks),
      status: aggregateOutcomes(checks),
      checks,
      checkedAtMs: this.clock.now(),
    };
  }

  // --- internals ---------------------------------------------------------

  /** Dispatch a fired alert fail-soft so a failing channel never breaks the metric path (Req 42.9). */
  private async dispatchAlert(alert: Alert): Promise<void> {
    try {
      await this.alertDispatcher.dispatch(alert);
    } catch {
      // Fail-soft: a failed alert delivery must not break the observed work.
    }
  }

  /** Run a set of probes, mapping a thrown probe to an `unhealthy` outcome (Req 46.6). */
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

/**
 * Decide whether an observed value crosses a threshold under a comparison — the
 * pure core of alert evaluation (Req 42.9).
 *
 * Total over every {@link ThresholdComparison}: `gt`/`gte` are upper bounds
 * (breached when the observed value is above / at-or-above the threshold) and
 * `lt`/`lte` are lower bounds (breached when below / at-or-below).
 *
 * @param comparison How the values are compared.
 * @param observed The observed metric value.
 * @param value The threshold value.
 * @returns `true` iff the observed value crosses the threshold.
 */
export function thresholdBreached(
  comparison: ThresholdComparison,
  observed: number,
  value: number,
): boolean {
  switch (comparison) {
    case 'gt':
      return observed > value;
    case 'gte':
      return observed >= value;
    case 'lt':
      return observed < value;
    case 'lte':
      return observed <= value;
  }
}

/**
 * Normalize a {@link StructuredLogEntry} to a plain, JSON-serializable,
 * secret-free object before it is emitted (Req 46.7).
 *
 * Round-trips {@link StructuredLogEntry.fields} through `JSON` so any non-JSON
 * value (a function, a symbol, an `undefined`) is dropped — guaranteeing the
 * emitted entry serializes cleanly — while the typed scalar fields are copied
 * directly. The caller is responsible for not putting secret VALUES in the
 * fields in the first place; this only guarantees serializability.
 *
 * @param entry The entry to normalize.
 * @returns A JSON-serializable copy safe to ship.
 */
export function toSerializableEntry(entry: StructuredLogEntry): StructuredLogEntry {
  const normalized: StructuredLogEntry = {
    level: entry.level,
    message: entry.message,
    correlationId: entry.correlationId,
    timestampMs: entry.timestampMs,
  };
  if (entry.service !== undefined) {
    normalized.service = entry.service;
  }
  if (entry.traceId !== undefined) {
    normalized.traceId = entry.traceId;
  }
  if (entry.spanId !== undefined) {
    normalized.spanId = entry.spanId;
  }
  if (entry.fields !== undefined) {
    normalized.fields = JSON.parse(JSON.stringify(entry.fields)) as Record<string, unknown>;
  }
  return normalized;
}
