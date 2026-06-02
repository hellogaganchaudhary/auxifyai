/**
 * Per-service health-check and readiness HTTP endpoints (Req 39.8, 46.6, 46.4).
 *
 * The platform exposes a health-check endpoint and a readiness endpoint for
 * EACH backend service (Req 39.8, 46.6); a load balancer drains traffic from
 * an instance whose health check fails (Req 39.7, 46.4). The
 * {@link import('@auxify/core').MonitoringService} produces the report
 * objects; this aggregator wires them onto the API surface as transport-
 * agnostic, HTTP-shaped responses.
 *
 * Transport-agnostic: like the {@link import('../../websocket').WebSocketGateway},
 * this module never imports an HTTP framework. A real Express/Fastify/Node
 * adapter writes {@link HealthEndpointResponse.statusCode} as the response
 * status and serializes {@link HealthEndpointResponse.body} as JSON. Returning
 * the report + status code together keeps the module fully unit-testable
 * without a real HTTP server.
 *
 * The status code mapping intentionally mirrors common load-balancer behavior:
 *   - `healthy` or `degraded` → `200 OK` (the instance is alive, even if
 *     partially impaired) so traffic continues;
 *   - `unhealthy` → `503 Service Unavailable` so the load balancer drains the
 *     instance until it recovers (Req 39.7, 46.4);
 *   - readiness → `200 OK` iff every readiness probe is `healthy`, else `503`
 *     so the orchestrator withholds traffic from a not-yet-ready instance.
 */

import type { ServiceMonitor } from './types';
import {
  HEALTH_HTTP_NOT_FOUND,
  HEALTH_HTTP_OK,
  HEALTH_HTTP_UNAVAILABLE,
  type HealthEndpointResponse,
  type HealthLookupResponse,
  type ReadinessEndpointResponse,
  type ReadinessLookupResponse,
  type UnknownServiceResponse,
} from './types';

/** Map a per-service health report status to its HTTP code (Req 39.8, 46.6). */
function liveCodeFor(status: 'healthy' | 'degraded' | 'unhealthy'): typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE {
  return status === 'unhealthy' ? HEALTH_HTTP_UNAVAILABLE : HEALTH_HTTP_OK;
}

/** Build the unknown-service response (Req 39.8): well-formed request, unknown name. */
function unknownService(service: string, available: string[]): UnknownServiceResponse {
  return {
    statusCode: HEALTH_HTTP_NOT_FOUND,
    body: {
      error: 'unknown_service',
      service,
      available,
    },
  };
}

/**
 * The api app's per-service health-check and readiness endpoint aggregator
 * (Req 39.8, 46.6).
 *
 * Each backend service registers its {@link ServiceMonitor} once at startup
 * with {@link MonitoringEndpoints.register}; thereafter the REST_API resolves a
 * `GET /health/:service` to {@link MonitoringEndpoints.health} and a
 * `GET /readiness/:service` to {@link MonitoringEndpoints.readiness}. The
 * cross-service overview ({@link MonitoringEndpoints.healthAll} /
 * {@link MonitoringEndpoints.readinessAll}) reports every registered service.
 */
export class MonitoringEndpoints {
  private readonly monitors = new Map<string, ServiceMonitor>();

  /** The number of currently-registered service monitors. */
  get serviceCount(): number {
    return this.monitors.size;
  }

  /** The names of currently-registered services, in registration order. */
  get registeredServices(): string[] {
    return [...this.monitors.keys()];
  }

  /**
   * Register a backend service's monitor (Req 39.8, 46.6).
   *
   * Re-registering an existing service replaces its monitor (so a service can
   * be reconfigured at startup without leaking the old monitor).
   *
   * @param monitor The {@link ServiceMonitor} to register.
   */
  register(monitor: ServiceMonitor): void {
    this.monitors.set(monitor.serviceName, monitor);
  }

  /**
   * Look up a registered monitor by service name.
   *
   * @param service The registered service name.
   * @returns The monitor, or `undefined` when none is registered.
   */
  monitorFor(service: string): ServiceMonitor | undefined {
    return this.monitors.get(service);
  }

  /**
   * Build the HTTP response for a per-service health-check endpoint
   * (Req 39.8, 46.6).
   *
   * Returns {@link HEALTH_HTTP_OK} (`200`) when the aggregate is `healthy` or
   * `degraded` and {@link HEALTH_HTTP_UNAVAILABLE} (`503`) when it is
   * `unhealthy` so the load balancer drains the instance (Req 39.7, 46.4).
   * A request for an unregistered service yields a `404` response so the
   * caller distinguishes "unhealthy" from "unknown service".
   *
   * @param service The service name to report on.
   * @returns The HTTP-shaped response.
   */
  async health(service: string): Promise<HealthLookupResponse> {
    const monitor = this.monitors.get(service);
    if (monitor === undefined) {
      return unknownService(service, this.registeredServices);
    }
    const body = await monitor.health();
    return { statusCode: liveCodeFor(body.status), body };
  }

  /**
   * Build the HTTP response for a per-service readiness endpoint (Req 39.8,
   * 46.6).
   *
   * Returns {@link HEALTH_HTTP_OK} (`200`) iff the service is ready (every
   * readiness probe is `healthy`) and {@link HEALTH_HTTP_UNAVAILABLE} (`503`)
   * otherwise so the orchestrator withholds traffic from the not-yet-ready
   * instance.
   *
   * @param service The service name to report on.
   * @returns The HTTP-shaped response.
   */
  async readiness(service: string): Promise<ReadinessLookupResponse> {
    const monitor = this.monitors.get(service);
    if (monitor === undefined) {
      return unknownService(service, this.registeredServices);
    }
    const body = await monitor.readiness();
    return {
      statusCode: body.ready ? HEALTH_HTTP_OK : HEALTH_HTTP_UNAVAILABLE,
      body,
    };
  }

  /**
   * Build the HTTP-shaped response for every registered service's liveness
   * report (Req 39.8, 46.6) — the cross-service overview an operator pulls.
   *
   * The aggregate status is `200` iff every per-service report is `200`; a
   * single unhealthy service degrades the overview to `503`.
   *
   * @returns The map of service name → per-service response.
   */
  async healthAll(): Promise<{
    statusCode: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE;
    services: Record<string, HealthEndpointResponse>;
  }> {
    const services: Record<string, HealthEndpointResponse> = {};
    let aggregate: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE = HEALTH_HTTP_OK;
    for (const monitor of this.monitors.values()) {
      const body = await monitor.health();
      const statusCode = liveCodeFor(body.status);
      services[monitor.serviceName] = { statusCode, body };
      if (statusCode === HEALTH_HTTP_UNAVAILABLE) {
        aggregate = HEALTH_HTTP_UNAVAILABLE;
      }
    }
    return { statusCode: aggregate, services };
  }

  /**
   * Build the HTTP-shaped response for every registered service's readiness
   * report (Req 39.8, 46.6).
   *
   * The aggregate status is `200` iff every per-service report is ready; a
   * single not-ready service degrades the overview to `503`.
   *
   * @returns The map of service name → per-service response.
   */
  async readinessAll(): Promise<{
    statusCode: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE;
    services: Record<string, ReadinessEndpointResponse>;
  }> {
    const services: Record<string, ReadinessEndpointResponse> = {};
    let aggregate: typeof HEALTH_HTTP_OK | typeof HEALTH_HTTP_UNAVAILABLE = HEALTH_HTTP_OK;
    for (const monitor of this.monitors.values()) {
      const body = await monitor.readiness();
      const statusCode = body.ready ? HEALTH_HTTP_OK : HEALTH_HTTP_UNAVAILABLE;
      services[monitor.serviceName] = { statusCode, body };
      if (statusCode === HEALTH_HTTP_UNAVAILABLE) {
        aggregate = HEALTH_HTTP_UNAVAILABLE;
      }
    }
    return { statusCode: aggregate, services };
  }
}
