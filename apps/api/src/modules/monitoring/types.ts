/**
 * Public contract for the api app's Monitoring_Service HTTP wiring (Req 39.8,
 * 42.8, 42.9, 46.6, 46.7).
 *
 * The platform's observability composition — metric collection, structured
 * correlated logging, distributed tracing, threshold alerting, and per-service
 * health/readiness aggregation — is the {@link MonitoringService} from
 * `@auxify/core`. Its `health(service)` and `readiness(service)` methods produce
 * report objects; the HTTP wiring of those reports onto per-service endpoints
 * is the REST_API's job (Req 39.8, 46.6) and is the contract this module
 * defines.
 *
 * SECURITY: alert payloads, log entries, and span attributes are secret-free
 * (Req 34.7 discipline). Channel identifiers, service names, and probe names
 * are all non-secret.
 */

import type {
  Alert,
  AlertChannel,
  AlertDispatcher,
  HealthCheck,
  HealthReport,
  LogSink,
  MetricStore,
  MonitoringClock,
  MonitoringService,
  ReadinessReport,
  Tracer,
} from '@auxify/core';

/**
 * The HTTP status code returned for a healthy or degraded liveness probe
 * (Req 46.6). `200` keeps the instance in rotation: it is alive, even if
 * partially impaired.
 */
export const HEALTH_HTTP_OK = 200 as const;

/**
 * The HTTP status code returned for an unhealthy liveness probe or a not-ready
 * readiness probe (Req 39.8, 46.6). `503` signals to the load balancer to drain
 * traffic from the instance until it recovers (Req 39.7, 46.4).
 */
export const HEALTH_HTTP_UNAVAILABLE = 503 as const;

/**
 * The HTTP status code returned when a request asks for an unknown service's
 * report (the request is well-formed but the named service is not registered).
 */
export const HEALTH_HTTP_NOT_FOUND = 404 as const;

/**
 * The HTTP-shaped response a per-service health-check endpoint returns
 * (Req 39.8, 46.6).
 *
 * Transport-agnostic: an HTTP framework adapter writes {@link statusCode} as
 * the response status and serializes {@link body} as JSON. Returning the report
 * + status code together (rather than embedding routing in the service) keeps
 * the module unit-testable without a real HTTP server.
 */
export interface HealthEndpointResponse {
  /** {@link HEALTH_HTTP_OK} when alive (healthy or degraded), {@link HEALTH_HTTP_UNAVAILABLE} when unhealthy. */
  statusCode: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE;
  /** The aggregate per-service liveness report. */
  body: HealthReport;
}

/**
 * The HTTP-shaped response a per-service readiness endpoint returns (Req 39.8,
 * 46.6).
 *
 * `200` iff the service is ready to receive traffic (every readiness probe is
 * `healthy`); `503` otherwise.
 */
export interface ReadinessEndpointResponse {
  /** {@link HEALTH_HTTP_OK} iff ready, else {@link HEALTH_HTTP_UNAVAILABLE}. */
  statusCode: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE;
  /** The aggregate per-service readiness report. */
  body: ReadinessReport;
}

/**
 * The HTTP-shaped response returned when a request asks for a service that is
 * not registered with the {@link MonitoringEndpoints}.
 */
export interface UnknownServiceResponse {
  statusCode: typeof HEALTH_HTTP_NOT_FOUND;
  body: {
    error: 'unknown_service';
    service: string;
    available: string[];
  };
}

/** Either a per-service health response or an unknown-service response. */
export type HealthLookupResponse = HealthEndpointResponse | UnknownServiceResponse;

/** Either a per-service readiness response or an unknown-service response. */
export type ReadinessLookupResponse = ReadinessEndpointResponse | UnknownServiceResponse;

/**
 * A backend service registered with the {@link MonitoringEndpoints} (Req 39.8,
 * 46.6).
 *
 * Each backend service in the platform — `rest-api`, `auth-service`,
 * `model-router`, `knowledge-ingestion`, … — owns its own {@link MonitoringService}
 * bound to its name, with its own liveness and readiness probes. The probes
 * live under the service's name so a per-service health endpoint reports only
 * THAT service's probes.
 */
export interface ServiceMonitor {
  /** The stable service name reported in {@link HealthReport.service} / {@link ReadinessReport.service}. */
  readonly serviceName: string;
  /** The service-bound {@link MonitoringService} (shares LogSink/Tracer/AlertDispatcher across services). */
  readonly monitoring: MonitoringService;
  /**
   * Add a liveness probe to this service's health report (Req 46.6).
   *
   * @param check The probe to register.
   */
  registerHealthCheck(check: HealthCheck): void;
  /**
   * Add a readiness probe gating traffic for this service (Req 46.6).
   *
   * @param check The probe to register.
   */
  registerReadinessCheck(check: HealthCheck): void;
  /** Build the aggregate liveness report for this service (Req 46.6, 39.8). */
  health(): Promise<HealthReport>;
  /** Build the aggregate readiness report for this service (Req 46.6, 39.8). */
  readiness(): Promise<ReadinessReport>;
}

/**
 * The handler that delivers a fired {@link Alert} on a single named channel
 * (Req 42.9).
 *
 * Production wires concrete handlers per channel — Slack webhook, email
 * distribution list, PagerDuty service. The {@link Alert.channel} identifier is
 * non-secret and never the destination's credential; secrets are referenced
 * by name only from the secret-store (Req 34.7).
 */
export interface AlertChannelHandler {
  /**
   * Deliver one alert through this channel.
   *
   * @param alert The fired alert (already secret-free).
   */
  send(alert: Alert): void | Promise<void>;
}

/**
 * Construction options for the {@link MultiChannelAlertDispatcher} (Req 42.9).
 */
export interface MultiChannelAlertDispatcherOptions {
  /** Per-channel handlers, keyed by {@link AlertChannel}. */
  channels?: Record<string, AlertChannelHandler>;
  /**
   * The handler used when an alert's {@link Alert.channel} is not registered.
   *
   * Production wires a handler that logs the alert through the structured
   * {@link LogSink} so a misconfigured channel never silently drops an alert.
   */
  fallback?: AlertChannelHandler;
}

/**
 * Construction options for the {@link JsonLogSink} (Req 46.7).
 *
 * The defaults write each {@link StructuredLogEntry} as a single JSON line —
 * `info`/`debug` to stdout and `warn`/`error` to stderr — so a process-level
 * log shipper can scrape them by stream. Both writers are injectable for tests.
 */
export interface JsonLogSinkOptions {
  /** Writer used for `debug` and `info` entries; defaults to `process.stdout`. */
  stdout?: (line: string) => void;
  /** Writer used for `warn` and `error` entries; defaults to `process.stderr`. */
  stderr?: (line: string) => void;
}

/**
 * Re-export of the core monitoring types referenced in the api app's wiring,
 * so importers of this module never need to reach into `@auxify/core` for the
 * shared shapes they use directly.
 */
export type {
  Alert,
  AlertChannel,
  AlertDispatcher,
  HealthCheck,
  HealthReport,
  LogSink,
  MetricStore,
  MonitoringClock,
  MonitoringService,
  ReadinessReport,
  Tracer,
};
