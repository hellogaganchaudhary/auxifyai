/**
 * Unit tests for the Monitoring_Service (Req 42.8, 42.9, 46.6, 46.7, 39.8).
 *
 * These drive the REAL {@link MonitoringService} over the in-memory fakes
 * (imported directly from `./fakes.js`, never the barrel) with a hand-advanced
 * {@link MutableMonitoringClock} as the only source of time, covering:
 *
 *   - recording a metric over its threshold dispatches exactly one alert on the
 *     configured channel and one under threshold dispatches none, across
 *     gt/gte/lt/lte (Req 42.8, 42.9);
 *   - collected metrics span the four categories and reach the metric store
 *     (Req 42.8);
 *   - structured log entries are JSON-serializable and carry the correlation id,
 *     and the logger factory stamps it automatically (Req 46.7);
 *   - startSpan/endSpan record a span with the trace id and a non-negative
 *     duration (Req 42.8);
 *   - health() is the worst-status-wins aggregate and readiness gates on all
 *     readiness checks (Req 46.6, 39.8);
 *   - the service is fail-soft when a sink/tracer/dispatcher throws;
 *   - a `thresholdBreached` pure test table.
 */

import { describe, expect, it } from 'vitest';

import { MonitoringService, thresholdBreached, toSerializableEntry } from './monitoring-service.js';
import {
  CapturingAlertDispatcher,
  CapturingLogSink,
  InMemoryMetricStore,
  MutableMonitoringClock,
  RecordingTracer,
  degradedCheck,
  healthyCheck,
  sequentialSpanIdGenerator,
  throwingCheck,
  unhealthyCheck,
} from './fakes.js';
import type { AlertThreshold, MetricPoint, ThresholdComparison } from './types.js';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);

interface Harness {
  service: MonitoringService;
  logSink: CapturingLogSink;
  tracer: RecordingTracer;
  alerts: CapturingAlertDispatcher;
  metrics: InMemoryMetricStore;
  clock: MutableMonitoringClock;
}

/** Wire the real service over in-memory fakes with a sequential span-id generator. */
function makeHarness(thresholds: readonly AlertThreshold[] = []): Harness {
  const logSink = new CapturingLogSink();
  const tracer = new RecordingTracer();
  const alerts = new CapturingAlertDispatcher();
  const metrics = new InMemoryMetricStore();
  const clock = new MutableMonitoringClock(START);
  const service = new MonitoringService({
    logSink,
    tracer,
    alertDispatcher: alerts,
    metricStore: metrics,
    thresholds,
    clock,
    spanIdGenerator: sequentialSpanIdGenerator(),
  });
  return { service, logSink, tracer, alerts, metrics, clock };
}

function metric(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    name: 'http.error.rate',
    category: 'application',
    value: 0,
    timestampMs: START,
    ...overrides,
  };
}

describe('MonitoringService.recordMetric — alerting (Req 42.8, 42.9)', () => {
  it('dispatches exactly one alert on the configured channel when a metric crosses a gt threshold', async () => {
    const h = makeHarness([
      { metricName: 'http.error.rate', comparison: 'gt', value: 0.05, channel: 'pagerduty' },
    ]);

    const fired = await h.service.recordMetric(metric({ value: 0.2 }));

    expect(fired).toHaveLength(1);
    expect(h.alerts.count).toBe(1);
    expect(h.alerts.onChannel('pagerduty')).toHaveLength(1);
    const alert = h.alerts.last;
    expect(alert?.thresholdMetric).toBe('http.error.rate');
    expect(alert?.observedValue).toBe(0.2);
    expect(alert?.channel).toBe('pagerduty');
    expect(alert?.firedAtMs).toBe(START);
  });

  it('dispatches no alert when a metric is under its gt threshold', async () => {
    const h = makeHarness([
      { metricName: 'http.error.rate', comparison: 'gt', value: 0.05, channel: 'pagerduty' },
    ]);

    const fired = await h.service.recordMetric(metric({ value: 0.01 }));

    expect(fired).toHaveLength(0);
    expect(h.alerts.count).toBe(0);
  });

  it('honors gte at the boundary (fires at the threshold, not below)', async () => {
    const h = makeHarness([
      { metricName: 'cpu.load', comparison: 'gte', value: 0.9, channel: 'slack' },
    ]);

    expect(await h.service.recordMetric(metric({ name: 'cpu.load', value: 0.9 }))).toHaveLength(1);
    expect(await h.service.recordMetric(metric({ name: 'cpu.load', value: 0.89 }))).toHaveLength(0);
    expect(h.alerts.onChannel('slack')).toHaveLength(1);
  });

  it('honors lt for a lower-bound metric (fires below the threshold)', async () => {
    const h = makeHarness([
      { metricName: 'disk.free.bytes', comparison: 'lt', value: 1000, channel: 'email' },
    ]);

    expect(
      await h.service.recordMetric(metric({ name: 'disk.free.bytes', value: 500 })),
    ).toHaveLength(1);
    expect(
      await h.service.recordMetric(metric({ name: 'disk.free.bytes', value: 1000 })),
    ).toHaveLength(0);
  });

  it('honors lte at the boundary (fires at-or-below)', async () => {
    const h = makeHarness([
      { metricName: 'health.score', comparison: 'lte', value: 0.5, channel: 'slack' },
    ]);

    expect(await h.service.recordMetric(metric({ name: 'health.score', value: 0.5 }))).toHaveLength(
      1,
    );
    expect(
      await h.service.recordMetric(metric({ name: 'health.score', value: 0.51 })),
    ).toHaveLength(0);
  });

  it('does not alert on a metric with no configured threshold', async () => {
    const h = makeHarness([
      { metricName: 'http.error.rate', comparison: 'gt', value: 0.05, channel: 'pagerduty' },
    ]);

    await h.service.recordMetric(metric({ name: 'unwatched.metric', value: 9999 }));

    expect(h.alerts.count).toBe(0);
  });

  it('evaluates multiple thresholds independently for one metric', async () => {
    const h = makeHarness();
    h.service.setThreshold({ metricName: 'cpu', comparison: 'gte', value: 0.8, channel: 'warn' });
    h.service.setThreshold({ metricName: 'cpu', comparison: 'gte', value: 0.95, channel: 'crit' });

    const fired = await h.service.recordMetric(metric({ name: 'cpu', value: 0.97 }));

    expect(fired).toHaveLength(2);
    expect(h.alerts.onChannel('warn')).toHaveLength(1);
    expect(h.alerts.onChannel('crit')).toHaveLength(1);
  });
});

describe('MonitoringService metric collection across categories (Req 42.8)', () => {
  it('collects system, application, business, and AI metrics into the store', async () => {
    const h = makeHarness();

    await h.service.recordMetrics([
      metric({ name: 'sys.cpu', category: 'system', value: 0.3 }),
      metric({ name: 'app.latency', category: 'application', value: 120 }),
      metric({ name: 'biz.active_orgs', category: 'business', value: 42 }),
      metric({ name: 'ai.tokens', category: 'ai', value: 1500 }),
    ]);

    expect(h.metrics.count).toBe(4);
    expect(h.metrics.inCategory('system')).toHaveLength(1);
    expect(h.metrics.inCategory('application')).toHaveLength(1);
    expect(h.metrics.inCategory('business')).toHaveLength(1);
    expect(h.metrics.inCategory('ai')).toHaveLength(1);
  });
});

describe('MonitoringService structured logging (Req 46.7)', () => {
  it('emits a JSON-serializable entry carrying the correlation id', () => {
    const h = makeHarness();

    const emitted = h.service.log({
      level: 'info',
      message: 'request handled',
      correlationId: 'corr-123',
      timestampMs: START,
      service: 'rest-api',
      fields: { route: '/v1/chat', status: 200 },
    });

    expect(h.logSink.count).toBe(1);
    const entry = h.logSink.last;
    expect(entry?.correlationId).toBe('corr-123');
    // JSON round-trips losslessly => serializable.
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
  });

  it('drops non-JSON field values so the emitted entry always serializes', () => {
    const h = makeHarness();

    const emitted = h.service.log({
      level: 'warn',
      message: 'partial fields',
      correlationId: 'corr-x',
      timestampMs: START,
      fields: {
        kept: 'value',
        // A function is not JSON-serializable and must be dropped.
        dropped: () => 'secret',
      } as Record<string, unknown>,
    });

    expect(emitted.fields).toEqual({ kept: 'value' });
    expect(JSON.stringify(emitted)).toContain('"kept":"value"');
  });

  it('logger factory stamps the correlation id (and service) on every line', () => {
    const h = makeHarness();
    const log = h.service.logger('corr-777', 'agent-runtime');

    log.info('starting');
    log.warn('slow dependency', { dependency: 'vector_store' });
    log.error('failed');

    const lines = h.logSink.withCorrelationId('corr-777');
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.service === 'agent-runtime')).toBe(true);
    expect(lines.map((line) => line.level)).toEqual(['info', 'warn', 'error']);
    expect(lines[1]?.fields).toEqual({ dependency: 'vector_store' });
    expect(lines.every((line) => line.timestampMs === START)).toBe(true);
  });

  it('stamps the clock instant on each line', () => {
    const h = makeHarness();
    const log = h.service.logger('corr-clock');

    log.info('first');
    h.clock.advance(5000);
    log.info('second');

    const lines = h.logSink.withCorrelationId('corr-clock');
    expect(lines[0]?.timestampMs).toBe(START);
    expect(lines[1]?.timestampMs).toBe(START + 5000);
  });

  it('is fail-soft when the log sink throws', () => {
    const h = makeHarness();
    h.logSink.shouldThrow = true;

    expect(() =>
      h.service.log({
        level: 'error',
        message: 'sink will throw',
        correlationId: 'corr-soft',
        timestampMs: START,
      }),
    ).not.toThrow();
  });
});

describe('MonitoringService distributed tracing (Req 42.8)', () => {
  it('records a finished span carrying the trace id with a non-negative duration', () => {
    const h = makeHarness();

    const span = h.service.startSpan('chat.send', {
      correlationId: 'corr-trace',
      service: 'chat-service',
    });
    h.clock.advance(250);
    const finished = h.service.endSpan(span);

    expect(h.tracer.count).toBe(1);
    const recorded = h.tracer.last;
    // Trace id defaults to the correlation id so logs and spans share a trace.
    expect(recorded?.traceId).toBe('corr-trace');
    expect(recorded?.spanId).toBe('span-1');
    expect(recorded?.name).toBe('chat.send');
    expect(recorded?.endMs).toBe(START + 250);
    expect((finished.endMs ?? 0) - finished.startMs).toBe(250);
    expect((finished.endMs ?? 0) - finished.startMs).toBeGreaterThanOrEqual(0);
  });

  it('uses an explicit trace id and nests under a parent span when supplied', () => {
    const h = makeHarness();

    const span = h.service.startSpan('db.query', {
      correlationId: 'corr-1',
      traceId: 'trace-abc',
      parentSpanId: 'span-parent',
      service: 'repositories',
    });
    const finished = h.service.endSpan(span, { rows: 10 });

    expect(finished.traceId).toBe('trace-abc');
    expect(finished.parentSpanId).toBe('span-parent');
    expect(finished.attributes).toEqual({ rows: 10 });
  });

  it('never produces a negative duration even if the clock does not advance', () => {
    const h = makeHarness();
    const span = h.service.startSpan('noop', { correlationId: 'c', service: 's' });
    const finished = h.service.endSpan(span);
    expect((finished.endMs ?? 0) - finished.startMs).toBe(0);
  });

  it('is fail-soft when the tracer throws', () => {
    const h = makeHarness();
    h.tracer.shouldThrow = true;
    const span = h.service.startSpan('s', { correlationId: 'c', service: 'svc' });
    expect(() => h.service.endSpan(span)).not.toThrow();
  });
});

describe('MonitoringService.health (Req 46.6, 39.8)', () => {
  it('returns healthy when every check passes', async () => {
    const h = makeHarness();
    h.service.registerCheck(healthyCheck('database'));
    h.service.registerCheck(healthyCheck('vector_store'));

    const report = await h.service.health('rest-api');

    expect(report.service).toBe('rest-api');
    expect(report.status).toBe('healthy');
    expect(report.checks).toHaveLength(2);
    expect(report.checkedAtMs).toBe(START);
  });

  it('returns degraded when a check is degraded and none is unhealthy', async () => {
    const h = makeHarness();
    h.service.registerCheck(healthyCheck('database'));
    h.service.registerCheck(degradedCheck('cache', 'high latency'));

    const report = await h.service.health('rest-api');

    expect(report.status).toBe('degraded');
  });

  it('returns unhealthy when any check is unhealthy (worst-status-wins)', async () => {
    const h = makeHarness();
    h.service.registerCheck(healthyCheck('database'));
    h.service.registerCheck(degradedCheck('cache'));
    h.service.registerCheck(unhealthyCheck('vector_store', 'unreachable'));

    const report = await h.service.health('rest-api');

    expect(report.status).toBe('unhealthy');
  });

  it('maps a check that throws to an unhealthy outcome rather than failing', async () => {
    const h = makeHarness();
    h.service.registerCheck(healthyCheck('database'));
    h.service.registerCheck(throwingCheck('flaky'));

    const report = await h.service.health('rest-api');

    expect(report.status).toBe('unhealthy');
    const flaky = report.checks.find((c) => c.name === 'flaky');
    expect(flaky?.status).toBe('unhealthy');
  });

  it('a service with no checks is healthy (live)', async () => {
    const h = makeHarness();
    const report = await h.service.health('worker');
    expect(report.status).toBe('healthy');
    expect(report.checks).toHaveLength(0);
  });
});

describe('MonitoringService.readiness (Req 46.6, 39.8)', () => {
  it('is ready iff every readiness check is healthy', async () => {
    const h = makeHarness();
    h.service.registerReadinessCheck(healthyCheck('migrations'));
    h.service.registerReadinessCheck(healthyCheck('dependencies'));

    const report = await h.service.readiness('rest-api');

    expect(report.ready).toBe(true);
    expect(report.status).toBe('healthy');
  });

  it('is not ready when any readiness check is degraded', async () => {
    const h = makeHarness();
    h.service.registerReadinessCheck(healthyCheck('migrations'));
    h.service.registerReadinessCheck(degradedCheck('warmup'));

    const report = await h.service.readiness('rest-api');

    expect(report.ready).toBe(false);
    expect(report.status).toBe('degraded');
  });

  it('is not ready when a readiness check is unhealthy', async () => {
    const h = makeHarness();
    h.service.registerReadinessCheck(unhealthyCheck('dependencies'));

    const report = await h.service.readiness('rest-api');

    expect(report.ready).toBe(false);
    expect(report.status).toBe('unhealthy');
  });

  it('readiness and liveness are independent registries', async () => {
    const h = makeHarness();
    h.service.registerCheck(unhealthyCheck('liveness-only'));
    h.service.registerReadinessCheck(healthyCheck('readiness-only'));

    expect((await h.service.health('svc')).status).toBe('unhealthy');
    expect((await h.service.readiness('svc')).ready).toBe(true);
  });
});

describe('MonitoringService alert dispatch is fail-soft (Req 42.9)', () => {
  it('does not throw when the alert channel fails, and still reports the fired alert', async () => {
    const h = makeHarness([{ metricName: 'm', comparison: 'gt', value: 1, channel: 'broken' }]);
    h.alerts.shouldThrow = true;

    const fired = await h.service.recordMetric(metric({ name: 'm', value: 5 }));

    // The alert was evaluated and returned even though delivery failed.
    expect(fired).toHaveLength(1);
    expect(h.alerts.count).toBe(0);
  });
});

describe('thresholdBreached (pure, Req 42.9)', () => {
  const cases: ReadonlyArray<[ThresholdComparison, number, number, boolean]> = [
    // gt: strictly above
    ['gt', 6, 5, true],
    ['gt', 5, 5, false],
    ['gt', 4, 5, false],
    // gte: at or above
    ['gte', 6, 5, true],
    ['gte', 5, 5, true],
    ['gte', 4, 5, false],
    // lt: strictly below
    ['lt', 4, 5, true],
    ['lt', 5, 5, false],
    ['lt', 6, 5, false],
    // lte: at or below
    ['lte', 4, 5, true],
    ['lte', 5, 5, true],
    ['lte', 6, 5, false],
  ];

  it.each(cases)('%s(%d, %d) === %s', (comparison, observed, value, expected) => {
    expect(thresholdBreached(comparison, observed, value)).toBe(expected);
  });
});

describe('toSerializableEntry (pure, Req 46.7)', () => {
  it('preserves the typed scalar fields and the correlation id', () => {
    const normalized = toSerializableEntry({
      level: 'debug',
      message: 'm',
      correlationId: 'c',
      timestampMs: 123,
      service: 'svc',
      traceId: 't',
      spanId: 's',
      fields: { a: 1 },
    });
    expect(normalized).toEqual({
      level: 'debug',
      message: 'm',
      correlationId: 'c',
      timestampMs: 123,
      service: 'svc',
      traceId: 't',
      spanId: 's',
      fields: { a: 1 },
    });
  });
});
