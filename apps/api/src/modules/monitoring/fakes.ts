/**
 * Test fakes for the api app's Monitoring_Service wiring (Req 39.8, 42.8, 42.9,
 * 46.6, 46.7).
 *
 * These in-memory doubles let unit tests drive the
 * {@link import('./endpoints').MonitoringEndpoints},
 * {@link import('./alert-dispatcher').MultiChannelAlertDispatcher},
 * {@link import('./service-monitor').CoreServiceMonitor},
 * {@link import('./json-log-sink').JsonLogSink}, and
 * {@link import('./factory').createMonitoringComposition} deterministically
 * without a real log shipper, alert channel, tracer, or HTTP server.
 *
 * Following the established convention (matching the WebSocket_Gateway's
 * `fakes.ts`), these are NOT re-exported from `./index.ts` — tests import them
 * directly from `./fakes`.
 */

import type {
  Alert,
  HealthCheck,
  HealthCheckResult,
  HealthStatus,
  LogSink,
  MonitoringClock,
  StructuredLogEntry,
} from '@auxify/core';

import type { AlertChannelHandler } from './types';

/** A capturing {@link LogSink} retaining every emitted entry (Req 46.7). */
export class CapturingLogSink implements LogSink {
  /** Every emitted entry, in order. */
  readonly entries: StructuredLogEntry[] = [];
  /** When `true`, {@link emit} throws to exercise the fail-soft path. */
  shouldThrow = false;

  emit(entry: StructuredLogEntry): void {
    if (this.shouldThrow) {
      throw new Error('log sink failure');
    }
    this.entries.push(entry);
  }

  /** Every emitted entry carrying the given correlation id. */
  withCorrelationId(correlationId: string): StructuredLogEntry[] {
    return this.entries.filter((entry) => entry.correlationId === correlationId);
  }
}

/** A capturing {@link AlertChannelHandler} retaining every delivered alert (Req 42.9). */
export class CapturingAlertChannel implements AlertChannelHandler {
  readonly received: Alert[] = [];
  /** When `true`, {@link send} throws to exercise the failing-handler path. */
  shouldThrow = false;

  send(alert: Alert): void {
    if (this.shouldThrow) {
      throw new Error('channel failure');
    }
    this.received.push(alert);
  }
}

/** A hand-advanceable {@link MonitoringClock}, for deterministic timestamps. */
export class MutableMonitoringClock implements MonitoringClock {
  private current: number;

  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(deltaMs: number): void {
    this.current += deltaMs;
  }
}

/** Build a {@link HealthCheck} that always resolves to the given status. */
export function fakeCheck(name: string, status: HealthStatus, detail?: string): HealthCheck {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
    check: async (): Promise<HealthCheckResult> =>
      detail === undefined ? { status } : { status, detail },
  };
}

/** Build a {@link HealthCheck} that throws, to verify the unhealthy mapping. */
export function throwingCheck(name: string): HealthCheck {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
    check: async () => {
      throw new Error(`probe "${name}" failed`);
    },
  };
}
