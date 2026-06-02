/**
 * Unit tests for the api app's Monitoring_Service wiring (Req 39.8, 42.8, 42.9,
 * 46.6, 46.7).
 *
 * Drives the api-app pieces — {@link JsonLogSink}, {@link MultiChannelAlertDispatcher},
 * {@link CoreServiceMonitor}, {@link MonitoringEndpoints}, and the
 * {@link createMonitoringComposition} factory — over the in-memory fakes in
 * `./fakes`, with a hand-advanced clock for determinism. The tests cover:
 *
 *   - JSON log lines split across stdout/stderr by level (Req 46.7);
 *   - per-channel alert routing with a logging fallback (Req 42.9);
 *   - per-service health/readiness HTTP status mapping
 *     (200 healthy/degraded, 503 unhealthy or not-ready, 404 unknown service)
 *     (Req 39.8, 46.6);
 *   - cross-service health/readiness aggregation degrades to 503 on any
 *     unhealthy/not-ready member;
 *   - end-to-end factory composition: a structured log line is JSON-stringified
 *     onto stdout and a fired threshold alert reaches the registered channel
 *     handler (Req 42.8, 42.9, 46.7);
 *   - alert-dispatch fail-soft: a throwing channel handler does not propagate
 *     out of `recordMetric` (Req 42.9).
 */

import { describe, expect, it } from 'vitest';

import {
  MultiChannelAlertDispatcher,
  loggingFallbackHandler,
} from './alert-dispatcher';
import { MonitoringEndpoints } from './endpoints';
import {
  HEALTH_HTTP_NOT_FOUND,
  HEALTH_HTTP_OK,
  HEALTH_HTTP_UNAVAILABLE,
} from './types';
import {
  CapturingAlertChannel,
  CapturingLogSink,
  MutableMonitoringClock,
  fakeCheck,
  throwingCheck,
} from './fakes';
import { JsonLogSink } from './json-log-sink';
import { createMonitoringComposition } from './factory';
import { CoreServiceMonitor } from './service-monitor';

// ---------------------------------------------------------------------------
// JsonLogSink (Req 46.7)
// ---------------------------------------------------------------------------

describe('JsonLogSink — JSON-line emission split by severity (Req 46.7)', () => {
  it('writes info/debug as a single JSON line on stdout, warn/error on stderr', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sink = new JsonLogSink({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    sink.emit({ level: 'info', message: 'i', correlationId: 'c1', timestampMs: 1 });
    sink.emit({ level: 'debug', message: 'd', correlationId: 'c2', timestampMs: 2 });
    sink.emit({ level: 'warn', message: 'w', correlationId: 'c3', timestampMs: 3 });
    sink.emit({ level: 'error', message: 'e', correlationId: 'c4', timestampMs: 4 });

    expect(stdout).toHaveLength(2);
    expect(stderr).toHaveLength(2);
    // every line round-trips back to the entry shape — proving the line is JSON
    expect(JSON.parse(stdout[0]!)).toEqual({
      level: 'info',
      message: 'i',
      correlationId: 'c1',
      timestampMs: 1,
    });
    expect(JSON.parse(stderr[1]!)).toEqual({
      level: 'error',
      message: 'e',
      correlationId: 'c4',
      timestampMs: 4,
    });
  });

  it('preserves correlationId and structured fields in the JSON line (Req 46.7)', () => {
    const stdout: string[] = [];
    const sink = new JsonLogSink({ stdout: (line) => stdout.push(line), stderr: () => {} });
    sink.emit({
      level: 'info',
      message: 'request handled',
      correlationId: 'corr-42',
      timestampMs: 1700000000000,
      service: 'rest-api',
      fields: { route: '/v1/chat', latencyMs: 17 },
    });

    const parsed = JSON.parse(stdout[0]!);
    expect(parsed.correlationId).toBe('corr-42');
    expect(parsed.service).toBe('rest-api');
    expect(parsed.fields).toEqual({ route: '/v1/chat', latencyMs: 17 });
  });
});

// ---------------------------------------------------------------------------
// MultiChannelAlertDispatcher (Req 42.9)
// ---------------------------------------------------------------------------

describe('MultiChannelAlertDispatcher — channel routing (Req 42.9)', () => {
  it('routes a fired alert to the handler for its channel', async () => {
    const slack = new CapturingAlertChannel();
    const pager = new CapturingAlertChannel();
    const dispatcher = new MultiChannelAlertDispatcher({
      channels: { slack, pagerduty: pager },
    });

    await dispatcher.dispatch({
      thresholdMetric: 'http.error_rate',
      observedValue: 0.05,
      threshold: { metricName: 'http.error_rate', comparison: 'gt', value: 0.01, channel: 'slack' },
      channel: 'slack',
      firedAtMs: 100,
    });

    expect(slack.received).toHaveLength(1);
    expect(pager.received).toHaveLength(0);
  });

  it('routes an unregistered channel to the fallback handler', async () => {
    const fallback = new CapturingAlertChannel();
    const dispatcher = new MultiChannelAlertDispatcher({ fallback });

    await dispatcher.dispatch({
      thresholdMetric: 'm',
      observedValue: 1,
      threshold: { metricName: 'm', comparison: 'gt', value: 0, channel: 'unknown' },
      channel: 'unknown',
      firedAtMs: 200,
    });

    expect(fallback.received).toHaveLength(1);
  });

  it('drops an unregistered alert silently when no fallback is configured', async () => {
    const dispatcher = new MultiChannelAlertDispatcher();
    // no throw, no observable side-effect — the core MonitoringService treats
    // dispatch fail-soft, so an undeliverable alert never breaks the metric path
    await expect(
      dispatcher.dispatch({
        thresholdMetric: 'm',
        observedValue: 1,
        threshold: { metricName: 'm', comparison: 'gt', value: 0, channel: 'unknown' },
        channel: 'unknown',
        firedAtMs: 300,
      }),
    ).resolves.toBeUndefined();
  });

  it('setHandler/removeHandler manage channels at runtime', async () => {
    const dispatcher = new MultiChannelAlertDispatcher();
    const slack = new CapturingAlertChannel();
    dispatcher.setHandler('slack', slack);
    expect(dispatcher.registeredChannels).toEqual(['slack']);

    await dispatcher.dispatch({
      thresholdMetric: 'm',
      observedValue: 1,
      threshold: { metricName: 'm', comparison: 'gt', value: 0, channel: 'slack' },
      channel: 'slack',
      firedAtMs: 1,
    });
    expect(slack.received).toHaveLength(1);

    expect(dispatcher.removeHandler('slack')).toBe(true);
    expect(dispatcher.registeredChannels).toEqual([]);
  });
});

describe('loggingFallbackHandler — captures alert in the structured log (Req 42.9, 46.7)', () => {
  it('emits a warn-level entry tagged with metric/channel/threshold details', () => {
    const sink = new CapturingLogSink();
    const handler = loggingFallbackHandler(sink);

    handler.send({
      thresholdMetric: 'cpu',
      observedValue: 0.92,
      threshold: { metricName: 'cpu', comparison: 'gt', value: 0.9, channel: 'oncall' },
      channel: 'oncall',
      firedAtMs: 999,
    });

    expect(sink.entries).toHaveLength(1);
    const entry = sink.entries[0]!;
    expect(entry.level).toBe('warn');
    expect(entry.fields).toMatchObject({
      metric: 'cpu',
      observedValue: 0.92,
      channel: 'oncall',
      comparison: 'gt',
      thresholdValue: 0.9,
    });
  });
});

// ---------------------------------------------------------------------------
// CoreServiceMonitor + MonitoringEndpoints (Req 39.8, 46.6)
// ---------------------------------------------------------------------------

describe('MonitoringEndpoints.health — HTTP status mapping (Req 39.8, 46.6)', () => {
  it('returns 200 with the report when every probe is healthy', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const monitor = composition.services['rest-api']!;
    monitor.registerHealthCheck(fakeCheck('database', 'healthy'));
    monitor.registerHealthCheck(fakeCheck('vector-store', 'healthy'));

    const response = await composition.endpoints.health('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_OK);
    if (response.statusCode === HEALTH_HTTP_OK) {
      expect(response.body.service).toBe('rest-api');
      expect(response.body.status).toBe('healthy');
      expect(response.body.checks).toHaveLength(2);
    }
  });

  it('returns 200 when an aggregate is degraded — the instance stays in rotation', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const monitor = composition.services['rest-api']!;
    monitor.registerHealthCheck(fakeCheck('database', 'healthy'));
    monitor.registerHealthCheck(fakeCheck('cache', 'degraded', 'redis lag'));

    const response = await composition.endpoints.health('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_OK);
    if (response.statusCode === HEALTH_HTTP_OK) {
      expect(response.body.status).toBe('degraded');
    }
  });

  it('returns 503 when ANY probe is unhealthy — the load balancer drains the instance', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const monitor = composition.services['rest-api']!;
    monitor.registerHealthCheck(fakeCheck('database', 'healthy'));
    monitor.registerHealthCheck(fakeCheck('vector-store', 'unhealthy', 'pgvector down'));

    const response = await composition.endpoints.health('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
    if (response.statusCode === HEALTH_HTTP_UNAVAILABLE) {
      expect(response.body.status).toBe('unhealthy');
    }
  });

  it('treats a thrown probe as unhealthy (Req 46.6)', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    composition.services['rest-api']!.registerHealthCheck(throwingCheck('flaky'));

    const response = await composition.endpoints.health('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
    if (response.statusCode === HEALTH_HTTP_UNAVAILABLE) {
      expect(response.body.checks[0]!.status).toBe('unhealthy');
    }
  });

  it('returns 404 with the available services when the named service is not registered', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api', 'auth'] });

    const response = await composition.endpoints.health('unknown-service');

    expect(response.statusCode).toBe(HEALTH_HTTP_NOT_FOUND);
    if (response.statusCode === HEALTH_HTTP_NOT_FOUND) {
      expect(response.body).toEqual({
        error: 'unknown_service',
        service: 'unknown-service',
        available: ['rest-api', 'auth'],
      });
    }
  });
});

describe('MonitoringEndpoints.readiness — readiness gate maps to 503 (Req 39.8, 46.6)', () => {
  it('returns 200 only when every readiness probe is healthy', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const monitor = composition.services['rest-api']!;
    monitor.registerReadinessCheck(fakeCheck('migrations', 'healthy'));
    monitor.registerReadinessCheck(fakeCheck('warmup', 'healthy'));

    const response = await composition.endpoints.readiness('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_OK);
    if (response.statusCode === HEALTH_HTTP_OK) {
      expect(response.body.ready).toBe(true);
    }
  });

  it('returns 503 when ANY readiness probe is degraded — withhold traffic', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const monitor = composition.services['rest-api']!;
    monitor.registerReadinessCheck(fakeCheck('migrations', 'healthy'));
    monitor.registerReadinessCheck(fakeCheck('warmup', 'degraded'));

    const response = await composition.endpoints.readiness('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
    if (response.statusCode === HEALTH_HTTP_UNAVAILABLE) {
      expect(response.body.ready).toBe(false);
    }
  });

  it('returns 503 when a readiness probe is unhealthy', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    composition.services['rest-api']!.registerReadinessCheck(
      fakeCheck('migrations', 'unhealthy'),
    );

    const response = await composition.endpoints.readiness('rest-api');

    expect(response.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
  });
});

describe('MonitoringEndpoints — cross-service overview (Req 39.8, 46.6)', () => {
  it('healthAll reports each service and the aggregate degrades to 503 if any is unhealthy', async () => {
    const composition = createMonitoringComposition({
      serviceNames: ['rest-api', 'auth', 'router'],
    });
    composition.services['rest-api']!.registerHealthCheck(fakeCheck('db', 'healthy'));
    composition.services['auth']!.registerHealthCheck(fakeCheck('idp', 'healthy'));
    composition.services['router']!.registerHealthCheck(fakeCheck('upstream', 'unhealthy'));

    const overview = await composition.endpoints.healthAll();

    expect(Object.keys(overview.services)).toEqual(['rest-api', 'auth', 'router']);
    expect(overview.services['rest-api']!.statusCode).toBe(HEALTH_HTTP_OK);
    expect(overview.services['auth']!.statusCode).toBe(HEALTH_HTTP_OK);
    expect(overview.services['router']!.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
    expect(overview.statusCode).toBe(HEALTH_HTTP_UNAVAILABLE);
  });

  it('readinessAll aggregates 200 only when every service is ready', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['a', 'b'] });
    composition.services['a']!.registerReadinessCheck(fakeCheck('p', 'healthy'));
    composition.services['b']!.registerReadinessCheck(fakeCheck('p', 'healthy'));

    const overview = await composition.endpoints.readinessAll();

    expect(overview.statusCode).toBe(HEALTH_HTTP_OK);
    expect(overview.services['a']!.body.ready).toBe(true);
    expect(overview.services['b']!.body.ready).toBe(true);
  });

  it('manually-registered service via endpoints.register is included in lookups', async () => {
    const composition = createMonitoringComposition({ serviceNames: ['rest-api'] });
    const extra = new CoreServiceMonitor('knowledge-ingestion', composition.monitoring);
    extra.registerHealthCheck(fakeCheck('parser', 'healthy'));
    composition.endpoints.register(extra);

    expect(composition.endpoints.serviceCount).toBe(2);
    const response = await composition.endpoints.health('knowledge-ingestion');
    expect(response.statusCode).toBe(HEALTH_HTTP_OK);
    if (response.statusCode === HEALTH_HTTP_OK) {
      expect(response.body.service).toBe('knowledge-ingestion');
    }
  });
});

// ---------------------------------------------------------------------------
// Composition: end-to-end through the factory (Req 42.8, 42.9, 46.7)
// ---------------------------------------------------------------------------

describe('createMonitoringComposition — end-to-end wiring', () => {
  it('uses the supplied LogSink and routes structured logs through it (Req 46.7)', () => {
    const logSink = new CapturingLogSink();
    const clock = new MutableMonitoringClock(1_700_000_000_000);
    const composition = createMonitoringComposition({
      serviceNames: ['rest-api'],
      logSink,
      clock,
    });

    composition.monitoring.logger('corr-1', 'rest-api').info('hello', { route: '/v1/x' });

    expect(logSink.entries).toHaveLength(1);
    const entry = logSink.entries[0]!;
    expect(entry.correlationId).toBe('corr-1');
    expect(entry.service).toBe('rest-api');
    expect(entry.timestampMs).toBe(1_700_000_000_000);
  });

  it('routes a fired threshold alert to the registered channel handler (Req 42.8, 42.9)', async () => {
    const slack = new CapturingAlertChannel();
    const composition = createMonitoringComposition({
      serviceNames: ['rest-api'],
      alertChannels: { slack },
      thresholds: [
        { metricName: 'http.error_rate', comparison: 'gt', value: 0.01, channel: 'slack' },
      ],
    });

    await composition.monitoring.recordMetric({
      name: 'http.error_rate',
      category: 'application',
      value: 0.05,
      timestampMs: 1,
    });

    expect(slack.received).toHaveLength(1);
    expect(slack.received[0]!.thresholdMetric).toBe('http.error_rate');
    expect(slack.received[0]!.observedValue).toBe(0.05);
  });

  it('does not dispatch when the metric stays inside the threshold (Req 42.9)', async () => {
    const slack = new CapturingAlertChannel();
    const composition = createMonitoringComposition({
      alertChannels: { slack },
      thresholds: [
        { metricName: 'http.error_rate', comparison: 'gt', value: 0.1, channel: 'slack' },
      ],
    });

    await composition.monitoring.recordMetric({
      name: 'http.error_rate',
      category: 'application',
      value: 0.05,
      timestampMs: 1,
    });

    expect(slack.received).toHaveLength(0);
  });

  it('a throwing channel handler does not propagate out of recordMetric (Req 42.9 fail-soft)', async () => {
    const broken = new CapturingAlertChannel();
    broken.shouldThrow = true;
    const composition = createMonitoringComposition({
      alertChannels: { broken },
      thresholds: [{ metricName: 'm', comparison: 'gt', value: 0, channel: 'broken' }],
    });

    const fired = await composition.monitoring.recordMetric({
      name: 'm',
      category: 'system',
      value: 1,
      timestampMs: 1,
    });

    // the alert is reported as fired even though the channel threw — fail-soft
    expect(fired).toHaveLength(1);
    expect(fired[0]!.channel).toBe('broken');
  });

  it('registers a service monitor for each name and exposes per-service endpoints', () => {
    const composition = createMonitoringComposition({
      serviceNames: ['rest-api', 'auth-service', 'model-router'],
    });

    expect(composition.endpoints.serviceCount).toBe(3);
    expect(composition.endpoints.registeredServices).toEqual([
      'rest-api',
      'auth-service',
      'model-router',
    ]);
    expect(composition.services['rest-api']!.serviceName).toBe('rest-api');
  });
});
