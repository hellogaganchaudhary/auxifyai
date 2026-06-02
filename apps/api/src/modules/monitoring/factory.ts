/**
 * Production wiring factory for the api app's Monitoring_Service composition
 * (Req 39.8, 42.8, 42.9, 46.6, 46.7).
 *
 * Composes a single, process-wide observability surface:
 *   - one core {@link MonitoringService} sharing one {@link LogSink},
 *     {@link Tracer}, {@link AlertDispatcher}, and {@link MetricStore} so logs
 *     and traces correlate across services on a single id (Req 46.7);
 *   - per-backend-service {@link CoreServiceMonitor}s registered with a
 *     {@link MonitoringEndpoints} aggregator that exposes per-service
 *     health-check and readiness endpoints (Req 39.8, 46.6).
 *
 * Defaults:
 *   - {@link JsonLogSink} writes structured JSON lines to stdout/stderr
 *     (Req 46.7);
 *   - the {@link MultiChannelAlertDispatcher} starts with no concrete channels
 *     and a logging fallback so a misconfigured alert is captured in the log
 *     stream rather than silently dropped (Req 42.9, 46.7);
 *   - alert thresholds, the {@link Tracer}, and the {@link MetricStore} are
 *     supplied by the caller (production wires concrete implementations; tests
 *     wire the in-memory fakes from `@auxify/core`'s `monitoring/fakes`).
 *
 * SECURITY: every channel handler the caller registers MUST read its
 * credential by NAME from the secret-store; this module never accepts a
 * credential value (Req 34.7).
 */

import {
  MonitoringService,
  type AlertThreshold,
  type LogSink,
  type MetricStore,
  type MonitoringClock,
  type Tracer,
} from '@auxify/core';

import {
  MultiChannelAlertDispatcher,
  loggingFallbackHandler,
} from './alert-dispatcher';
import { MonitoringEndpoints } from './endpoints';
import { JsonLogSink } from './json-log-sink';
import { CoreServiceMonitor } from './service-monitor';
import type { AlertChannelHandler, ServiceMonitor } from './types';

/** Construction options for {@link createMonitoringComposition}. */
export interface CreateMonitoringCompositionOptions {
  /**
   * The names of the backend services to register up front (Req 39.8, 46.6).
   *
   * Each name produces a {@link ServiceMonitor} bound to the shared
   * {@link MonitoringService} and registered with the
   * {@link MonitoringEndpoints} aggregator. Additional services can be
   * registered later via {@link MonitoringEndpoints.register}.
   */
  serviceNames?: readonly string[];
  /**
   * The {@link LogSink} structured log entries are emitted through (Req 46.7).
   * Defaults to a {@link JsonLogSink} writing JSON lines to stdout/stderr.
   */
  logSink?: LogSink;
  /**
   * Per-channel {@link AlertChannelHandler}s for the dispatcher (Req 42.9).
   * Each key is a non-secret {@link import('@auxify/core').AlertChannel}.
   */
  alertChannels?: Record<string, AlertChannelHandler>;
  /**
   * The handler an alert routes to when its channel has no registered handler
   * (Req 42.9). Defaults to {@link loggingFallbackHandler} over `logSink` so a
   * misconfigured alert is captured in the structured log stream.
   */
  alertFallback?: AlertChannelHandler;
  /** Optional initial alert thresholds (Req 42.9). */
  thresholds?: readonly AlertThreshold[];
  /** Optional distributed-tracing exporter (Req 42.8). */
  tracer?: Tracer;
  /** Optional metrics store (Req 42.8). */
  metricStore?: MetricStore;
  /** Optional clock (defaults to the system clock). */
  clock?: MonitoringClock;
}

/**
 * The composed Monitoring_Service surface returned by
 * {@link createMonitoringComposition}.
 */
export interface MonitoringComposition {
  /** The shared core observability service (metrics, logs, traces, alerts). */
  monitoring: MonitoringService;
  /** The per-service health/readiness endpoint aggregator. */
  endpoints: MonitoringEndpoints;
  /** Per-service monitor handles, keyed by service name. */
  services: Record<string, ServiceMonitor>;
  /** The {@link LogSink} the composition emits structured logs through (Req 46.7). */
  logSink: LogSink;
  /** The {@link MultiChannelAlertDispatcher} fired alerts route through (Req 42.9). */
  alertDispatcher: MultiChannelAlertDispatcher;
}

/**
 * Compose the api app's Monitoring_Service surface (Req 39.8, 42.8, 42.9, 46.6,
 * 46.7).
 *
 * Wires the shared {@link MonitoringService} over a {@link JsonLogSink} (or the
 * caller's sink), a {@link MultiChannelAlertDispatcher} (with a logging
 * fallback by default), and the optional {@link Tracer}/{@link MetricStore}
 * the caller supplies; produces a {@link CoreServiceMonitor} for each named
 * backend service and registers them with a {@link MonitoringEndpoints}
 * aggregator that exposes per-service health-check and readiness endpoints.
 *
 * @param options The composition options.
 * @returns The composed surface — `monitoring`, `endpoints`, `services`,
 *          `logSink`, `alertDispatcher`.
 */
export function createMonitoringComposition(
  options: CreateMonitoringCompositionOptions = {},
): MonitoringComposition {
  const logSink: LogSink = options.logSink ?? new JsonLogSink();
  const alertDispatcher = new MultiChannelAlertDispatcher({
    ...(options.alertChannels !== undefined ? { channels: options.alertChannels } : {}),
    fallback: options.alertFallback ?? loggingFallbackHandler(logSink),
  });

  const monitoring = new MonitoringService({
    logSink,
    alertDispatcher,
    ...(options.tracer !== undefined ? { tracer: options.tracer } : {}),
    ...(options.metricStore !== undefined ? { metricStore: options.metricStore } : {}),
    ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  const endpoints = new MonitoringEndpoints();
  const services: Record<string, ServiceMonitor> = {};
  for (const serviceName of options.serviceNames ?? []) {
    const monitor = new CoreServiceMonitor(serviceName, monitoring);
    services[serviceName] = monitor;
    endpoints.register(monitor);
  }

  return { monitoring, endpoints, services, logSink, alertDispatcher };
}
