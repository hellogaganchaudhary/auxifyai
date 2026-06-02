/**
 * Test fakes and builders for the Monitoring_Service (Req 42.8, 42.9, 46.6,
 * 46.7, 39.8).
 *
 * The Monitoring_Service composes its ports — a {@link LogSink}, an optional
 * {@link Tracer}, an {@link AlertDispatcher}, an optional {@link MetricStore},
 * a {@link HealthCheck} registry, and a {@link MonitoringClock}. These in-memory
 * fakes let unit tests drive the service deterministically and inspect exactly
 * what was logged, traced, alerted, and collected — without a log shipper, a
 * trace exporter, an alerting channel, or real time:
 *
 *   - {@link CapturingLogSink} records every emitted {@link StructuredLogEntry};
 *   - {@link RecordingTracer} records every finished {@link TraceSpan};
 *   - {@link CapturingAlertDispatcher} records every dispatched {@link Alert}
 *     and can be made to throw to exercise the fail-soft path;
 *   - {@link InMemoryMetricStore} records every collected {@link MetricPoint};
 *   - {@link MutableMonitoringClock} is a hand-advanceable clock so span
 *     durations and timestamps are deterministic;
 *   - {@link healthyCheck} / {@link unhealthyCheck} / {@link degradedCheck} /
 *     {@link throwingCheck} build {@link HealthCheck} stubs;
 *   - {@link sequentialSpanIdGenerator} hands out assertion-friendly span ids.
 *
 * These are imported directly from `./fakes.js` by the unit tests (never from
 * the package barrel), matching the established convention.
 */

import type { SpanIdGenerator } from './monitoring-service.js';
import type {
  Alert,
  AlertDispatcher,
  HealthCheck,
  HealthStatus,
  MetricPoint,
  MetricStore,
  MonitoringClock,
  LogSink,
  StructuredLogEntry,
  TraceSpan,
  Tracer,
} from './types.js';

/**
 * A capturing {@link LogSink} storing every emitted entry so tests can assert
 * what was logged and that each line carried its correlation id (Req 46.7).
 */
export class CapturingLogSink implements LogSink {
  /** Every emitted entry, in order. */
  readonly entries: StructuredLogEntry[] = [];
  /** When `true`, {@link emit} throws, to exercise the service's fail-soft path. */
  shouldThrow = false;

  emit(entry: StructuredLogEntry): void {
    if (this.shouldThrow) {
      throw new Error('log sink failure');
    }
    this.entries.push(entry);
  }

  /** The number of entries emitted so far. */
  get count(): number {
    return this.entries.length;
  }

  /** The single most recently emitted entry, or `undefined` if none. */
  get last(): StructuredLogEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** Every emitted entry carrying the given correlation id. */
  withCorrelationId(correlationId: string): StructuredLogEntry[] {
    return this.entries.filter((entry) => entry.correlationId === correlationId);
  }
}

/**
 * A recording {@link Tracer} storing every finished span so tests can assert the
 * trace id and a non-negative duration (Req 42.8).
 */
export class RecordingTracer implements Tracer {
  /** Every recorded finished span, in order. */
  readonly spans: TraceSpan[] = [];
  /** When `true`, {@link record} throws, to exercise the service's fail-soft path. */
  shouldThrow = false;

  record(span: TraceSpan): void {
    if (this.shouldThrow) {
      throw new Error('tracer failure');
    }
    this.spans.push(span);
  }

  /** The number of spans recorded so far. */
  get count(): number {
    return this.spans.length;
  }

  /** The single most recently recorded span, or `undefined` if none. */
  get last(): TraceSpan | undefined {
    return this.spans[this.spans.length - 1];
  }
}

/**
 * A capturing {@link AlertDispatcher} storing every dispatched alert so tests can
 * assert which alerts fired and on which channel (Req 42.9).
 */
export class CapturingAlertDispatcher implements AlertDispatcher {
  /** Every dispatched alert, in order. */
  readonly alerts: Alert[] = [];
  /** When `true`, {@link dispatch} throws, to exercise the service's fail-soft path. */
  shouldThrow = false;

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async dispatch(alert: Alert): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('alert channel failure');
    }
    this.alerts.push(alert);
  }

  /** The number of alerts dispatched so far. */
  get count(): number {
    return this.alerts.length;
  }

  /** Every dispatched alert sent through the given channel. */
  onChannel(channel: string): Alert[] {
    return this.alerts.filter((alert) => alert.channel === channel);
  }

  /** The single most recently dispatched alert, or `undefined` if none. */
  get last(): Alert | undefined {
    return this.alerts[this.alerts.length - 1];
  }
}

/**
 * An in-memory {@link MetricStore} recording every collected metric so tests can
 * assert which points were collected across the four categories (Req 42.8).
 */
export class InMemoryMetricStore implements MetricStore {
  /** Every recorded metric, in order. */
  readonly points: MetricPoint[] = [];

  record(point: MetricPoint): void {
    this.points.push(point);
  }

  /** The number of metrics recorded so far. */
  get count(): number {
    return this.points.length;
  }

  /** Every recorded metric in the given category. */
  inCategory(category: MetricPoint['category']): MetricPoint[] {
    return this.points.filter((point) => point.category === category);
  }
}

/**
 * A hand-advanceable {@link MonitoringClock}, so span durations and log/alert
 * timestamps are deterministic: fix "now" at construction, then {@link advance}
 * it (or {@link set} an absolute instant).
 */
export class MutableMonitoringClock implements MonitoringClock {
  private current: number;

  /** @param startMs The initial "now" in epoch milliseconds (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  /** The current time in milliseconds since the Unix epoch. */
  now(): number {
    return this.current;
  }

  /** Advance the clock by `deltaMs` milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Set the clock to an absolute epoch-millisecond instant. */
  set(absoluteMs: number): void {
    this.current = absoluteMs;
  }
}

/** Build a {@link HealthCheck} that always resolves `healthy`. */
export function healthyCheck(name: string, detail?: string): HealthCheck {
  return makeCheck(name, 'healthy', detail);
}

/** Build a {@link HealthCheck} that always resolves `degraded`. */
export function degradedCheck(name: string, detail?: string): HealthCheck {
  return makeCheck(name, 'degraded', detail);
}

/** Build a {@link HealthCheck} that always resolves `unhealthy`. */
export function unhealthyCheck(name: string, detail?: string): HealthCheck {
  return makeCheck(name, 'unhealthy', detail);
}

/**
 * Build a {@link HealthCheck} that always rejects, to verify the service maps a
 * thrown probe to an `unhealthy` outcome (Req 46.6).
 */
export function throwingCheck(name: string): HealthCheck {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
    check: async () => {
      throw new Error(`health check "${name}" failed`);
    },
  };
}

function makeCheck(name: string, status: HealthStatus, detail?: string): HealthCheck {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
    check: async () => (detail === undefined ? { status } : { status, detail }),
  };
}

/**
 * A deterministic {@link SpanIdGenerator} handing out `span-1`, `span-2`, … ids,
 * for assertion-friendly tests.
 */
export function sequentialSpanIdGenerator(): SpanIdGenerator {
  let counter = 0;
  return {
    spanId: () => `span-${(counter += 1)}`,
  };
}
