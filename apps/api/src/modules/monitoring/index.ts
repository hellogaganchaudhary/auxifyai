/**
 * Monitoring_Service and per-service health/readiness HTTP endpoints for the
 * api app (Req 39.8, 42.8, 42.9, 46.6, 46.7).
 *
 * The platform's observability composition — metric collection across the four
 * categories (system, application, business, AI) (Req 42.8), structured
 * JSON-serializable correlated logs (Req 46.7), distributed tracing (Req 42.8),
 * threshold alerting on configured channels (Req 42.9), and per-service
 * health/readiness aggregation (Req 39.8, 46.6) — is the core
 * {@link import('@auxify/core').MonitoringService}. This module wires that
 * service to the api process:
 *
 *   - {@link JsonLogSink} writes each {@link import('@auxify/core').StructuredLogEntry}
 *     as a single JSON line on stdout/stderr (Req 46.7);
 *   - {@link MultiChannelAlertDispatcher} routes a fired alert to the handler
 *     registered for its channel, with {@link loggingFallbackHandler} as a
 *     log-stream fallback so a misconfigured alert is never silently dropped
 *     (Req 42.9);
 *   - {@link CoreServiceMonitor} binds a backend service name to the shared
 *     observability service and tracks its own probes;
 *   - {@link MonitoringEndpoints} exposes per-service health-check and
 *     readiness endpoints as transport-agnostic, HTTP-shaped responses
 *     (Req 39.8, 46.6) — `200` for healthy/degraded liveness, `503` for
 *     unhealthy or not-ready, `404` for an unknown service;
 *   - {@link createMonitoringComposition} composes the surface in production
 *     shape with sensible defaults.
 *
 * The HTTP wiring is transport-agnostic exactly as the WebSocket_Gateway is:
 * an Express/Fastify/Node adapter writes the response status from
 * {@link MonitoringEndpoints.health}'s `statusCode` and serializes its `body`
 * as JSON.
 *
 * SECURITY: logs, alerts, and span attributes are secret-free (Req 34.7).
 * Channel handlers MUST read their credentials by NAME from the secret-store;
 * this module never accepts a credential value.
 */

export { JsonLogSink } from './json-log-sink';
export {
  MultiChannelAlertDispatcher,
  loggingFallbackHandler,
} from './alert-dispatcher';
export { CoreServiceMonitor } from './service-monitor';
export { MonitoringEndpoints } from './endpoints';
export { createMonitoringComposition } from './factory';
export type {
  CreateMonitoringCompositionOptions,
  MonitoringComposition,
} from './factory';
export {
  HEALTH_HTTP_OK,
  HEALTH_HTTP_NOT_FOUND,
  HEALTH_HTTP_UNAVAILABLE,
} from './types';
export type {
  Alert,
  AlertChannel,
  AlertChannelHandler,
  AlertDispatcher,
  HealthCheck,
  HealthEndpointResponse,
  HealthLookupResponse,
  HealthReport,
  JsonLogSinkOptions,
  LogSink,
  MetricStore,
  MonitoringClock,
  MonitoringService,
  MultiChannelAlertDispatcherOptions,
  ReadinessEndpointResponse,
  ReadinessLookupResponse,
  ReadinessReport,
  ServiceMonitor,
  Tracer,
  UnknownServiceResponse,
} from './types';
