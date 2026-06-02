/**
 * Multi-channel {@link AlertDispatcher} for the api app's Monitoring_Service
 * wiring (Req 42.9).
 *
 * A fired {@link Alert} is delivered through the {@link AlertChannelHandler}
 * registered for its {@link Alert.channel}. When the channel is not registered
 * the dispatcher routes the alert to the {@link MultiChannelAlertDispatcherOptions.fallback}
 * handler — typically a handler that logs through the structured {@link LogSink}
 * (Req 46.7) — so a misconfigured channel never silently drops an alert.
 *
 * The dispatcher itself is fail-safe by design: any error a channel handler
 * throws is propagated to the {@link import('@auxify/core').MonitoringService},
 * which catches it fail-soft so a failing alert channel never breaks the work
 * that produced the metric (Req 42.9). Production wires concrete channel
 * handlers (Slack webhook, email distribution list, PagerDuty service) where
 * the handler reads its credential by NAME from the secret-store (Req 34.7),
 * never inline.
 */

import type { Alert, AlertDispatcher } from '@auxify/core';

import type {
  AlertChannelHandler,
  LogSink,
  MultiChannelAlertDispatcherOptions,
} from './types';

/**
 * Build a fallback {@link AlertChannelHandler} that records an alert through
 * the structured {@link LogSink} (Req 42.9, 46.7).
 *
 * Useful as the default fallback for {@link MultiChannelAlertDispatcher}: an
 * alert routed to an unregistered channel is captured as a `warn`-level entry
 * tagged with the alert's metric, observed value, channel, and the breached
 * threshold — all secret-free.
 */
export function loggingFallbackHandler(logSink: LogSink): AlertChannelHandler {
  return {
    send(alert: Alert): void {
      logSink.emit({
        level: 'warn',
        message: 'alert dispatched to fallback (no handler registered for channel)',
        correlationId: `alert-${alert.thresholdMetric}-${alert.firedAtMs}`,
        timestampMs: alert.firedAtMs,
        service: 'monitoring',
        fields: {
          metric: alert.thresholdMetric,
          observedValue: alert.observedValue,
          channel: alert.channel,
          comparison: alert.threshold.comparison,
          thresholdValue: alert.threshold.value,
        },
      });
    },
  };
}

/**
 * An {@link AlertDispatcher} that routes a fired {@link Alert} to a per-channel
 * handler (Req 42.9).
 *
 * Channels are registered up front (or via {@link setHandler}) keyed by their
 * non-secret {@link import('@auxify/core').AlertChannel} identifier. Dispatch
 * lookup is exact-string: `slack`, `pagerduty`, `email-ops`, etc. An alert
 * whose channel has no registered handler routes to the fallback handler.
 *
 * The dispatcher does NOT swallow handler errors — the fail-soft contract lives
 * in the core {@link import('@auxify/core').MonitoringService} so every
 * {@link AlertDispatcher} implementation has the same guarantee at the same
 * layer.
 */
export class MultiChannelAlertDispatcher implements AlertDispatcher {
  private readonly handlers = new Map<string, AlertChannelHandler>();
  private readonly fallback: AlertChannelHandler | undefined;

  constructor(options: MultiChannelAlertDispatcherOptions = {}) {
    if (options.channels !== undefined) {
      for (const [channel, handler] of Object.entries(options.channels)) {
        this.handlers.set(channel, handler);
      }
    }
    this.fallback = options.fallback;
  }

  /** The channel identifiers currently registered, in insertion order. */
  get registeredChannels(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Register (or replace) a handler for a channel (Req 42.9).
   *
   * @param channel The non-secret channel identifier.
   * @param handler The handler that delivers an alert through that channel.
   */
  setHandler(channel: string, handler: AlertChannelHandler): void {
    this.handlers.set(channel, handler);
  }

  /**
   * Remove the handler for a channel.
   *
   * @param channel The channel whose handler to remove.
   * @returns `true` if a handler was removed.
   */
  removeHandler(channel: string): boolean {
    return this.handlers.delete(channel);
  }

  /**
   * Dispatch an alert through its channel's handler (Req 42.9).
   *
   * Routes to the configured handler when the channel is registered, otherwise
   * to the fallback handler. When no fallback is configured an unregistered
   * channel yields a no-op (the calling
   * {@link import('@auxify/core').MonitoringService} treats every dispatch
   * outcome fail-soft).
   *
   * @param alert The fired alert to deliver.
   */
  async dispatch(alert: Alert): Promise<void> {
    const handler = this.handlers.get(alert.channel) ?? this.fallback;
    if (handler === undefined) {
      return;
    }
    await handler.send(alert);
  }
}
