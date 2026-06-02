/**
 * The provider health checker and availability gating (Req 2.10, task 5.4).
 *
 * {@link ProviderHealthChecker} periodically polls each registered
 * {@link AIProvider}'s `healthCheck()` and projects the outcome onto the
 * {@link ModelRegistry}: when a provider's check fails (`healthy: false` or the
 * call throws), every model that provider serves is marked unavailable; when a
 * later check for that provider succeeds, those models are marked available
 * again. Availability therefore always reflects the most recent health outcome
 * (Req 2.10), so the Model_Router can exclude known-bad providers from selection
 * rather than discovering failures per request.
 *
 * The checker is built for testability without real timers. One polling round
 * is a single call to {@link ProviderHealthChecker.checkAll}, which tests invoke
 * directly; the periodic loop ({@link ProviderHealthChecker.start} /
 * {@link ProviderHealthChecker.stop}) merely schedules that same method through
 * an injectable {@link SchedulerLike}, so production uses real timers while
 * tests use a fake scheduler (or skip scheduling entirely).
 *
 * Each round is resilient: a single provider whose `healthCheck()` rejects, or a
 * single registry mutation that throws, never prevents the remaining providers
 * and models from being evaluated.
 */

import type { ModelRegistry, AIProvider } from './types.js';

/**
 * The scheduling primitive the periodic loop depends on, abstracted to a single
 * method so it can be backed by real timers in production and a fake in tests.
 *
 * `schedule` arranges for `run` to be invoked roughly every `intervalMs`
 * milliseconds and returns a cancel function that stops further invocations.
 * Returning an opaque cancel callback (rather than a timer handle) keeps the
 * contract free of any environment-specific timer type.
 */
export interface SchedulerLike {
  /**
   * Schedule `run` to be invoked every `intervalMs` milliseconds.
   *
   * @returns A function that, when called, cancels all further invocations.
   */
  schedule(run: () => void, intervalMs: number): () => void;
}

/** The default {@link SchedulerLike}, backed by the global `setInterval`. */
const defaultScheduler: SchedulerLike = {
  schedule(run, intervalMs) {
    const handle = setInterval(run, intervalMs);
    // Don't let the poller keep an otherwise-idle process alive.
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
    return () => {
      clearInterval(handle);
    };
  },
};

/** Construction options for a {@link ProviderHealthChecker}. */
export interface ProviderHealthCheckerOptions {
  /**
   * The scheduler used by {@link ProviderHealthChecker.start}; defaults to one
   * backed by the global `setInterval`. Inject a fake to drive the periodic
   * loop deterministically in tests.
   */
  scheduler?: SchedulerLike;
}

/**
 * The outcome of checking a single provider during one polling round.
 *
 * Returned by {@link ProviderHealthChecker.checkAll} so callers (and tests) can
 * observe what happened without inspecting the registry — which models had their
 * availability set, whether the provider was healthy, and any failure detail.
 */
export interface ProviderHealthCheckResult {
  /** The provider this result describes. */
  providerId: string;
  /** Whether the provider's health check reported healthy this round. */
  healthy: boolean;
  /**
   * The ids of the models served by this provider whose availability was set
   * this round (marked available when healthy, unavailable when not).
   */
  affectedModelIds: string[];
  /**
   * A human-readable detail, typically the failure reason when unhealthy or the
   * thrown error's message when `healthCheck()` rejected.
   */
  detail?: string;
}

/**
 * Polls provider health and gates model availability in the registry (Req 2.10).
 *
 * Providers and the registry are supplied via constructor injection so the
 * checker owns no global state and is trivially unit-testable.
 */
export class ProviderHealthChecker {
  /** The providers polled each round, captured once at construction. */
  private readonly providers: readonly AIProvider[];

  /** The registry whose model availability is gated by health outcomes. */
  private readonly registry: ModelRegistry;

  /** The scheduler used to drive the periodic loop. */
  private readonly scheduler: SchedulerLike;

  /** The active cancel function while the periodic loop is running, else `undefined`. */
  private cancel: (() => void) | undefined;

  /** Guards against overlapping rounds when a check outlasts the interval. */
  private inFlight = false;

  /**
   * @param providers The providers to poll (any iterable; copied defensively).
   * @param registry  The registry to gate; its `markAvailable`/`markUnavailable`
   *                  are called per affected model.
   * @param options   Optional injected {@link SchedulerLike}.
   */
  constructor(
    providers: Iterable<AIProvider>,
    registry: ModelRegistry,
    options: ProviderHealthCheckerOptions = {},
  ) {
    this.providers = [...providers];
    this.registry = registry;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Whether the periodic polling loop is currently running. */
  get running(): boolean {
    return this.cancel !== undefined;
  }

  /**
   * Perform one polling round: check every provider's health and gate the
   * availability of the models it serves (Req 2.10).
   *
   * Providers are checked concurrently; the returned results preserve provider
   * order. The round is resilient — a provider whose `healthCheck()` rejects is
   * treated as unhealthy, and any per-model registry error is contained — so one
   * failure never prevents the others from being evaluated.
   */
  async checkAll(): Promise<ProviderHealthCheckResult[]> {
    return Promise.all(this.providers.map((provider) => this.checkProvider(provider)));
  }

  /**
   * Start polling every `intervalMs` milliseconds (Req 2.10).
   *
   * Idempotent: calling `start` while already running is a no-op. The loop does
   * not run an immediate round; the first round occurs after `intervalMs`. Use
   * {@link ProviderHealthChecker.checkAll} to run a round on demand.
   *
   * @throws {RangeError} when `intervalMs` is not a positive finite number.
   */
  start(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`intervalMs must be a positive finite number, got ${intervalMs}`);
    }
    if (this.cancel !== undefined) {
      return;
    }
    this.cancel = this.scheduler.schedule(() => {
      void this.runScheduledRound();
    }, intervalMs);
  }

  /** Stop the periodic polling loop. Idempotent when not running. */
  stop(): void {
    if (this.cancel !== undefined) {
      this.cancel();
      this.cancel = undefined;
    }
  }

  /**
   * Run a scheduled round, skipping the tick if a prior round is still in
   * flight so a slow check never causes overlapping rounds to pile up.
   */
  private async runScheduledRound(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.checkAll();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Check one provider and gate the availability of the models it serves.
   * Never rejects: a thrown/rejected `healthCheck()` is treated as unhealthy.
   */
  private async checkProvider(provider: AIProvider): Promise<ProviderHealthCheckResult> {
    let healthy: boolean;
    let detail: string | undefined;

    try {
      const status = await provider.healthCheck();
      healthy = status.healthy === true;
      detail = status.detail;
    } catch (error) {
      healthy = false;
      detail = error instanceof Error ? error.message : String(error);
    }

    const affectedModelIds = this.applyAvailability(provider.providerId, healthy);

    return {
      providerId: provider.providerId,
      healthy,
      affectedModelIds,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  /**
   * Mark every model served by `providerId` available (when `healthy`) or
   * unavailable (when not), returning the ids actually set. A registry error for
   * one model is swallowed so the rest of the provider's models still update.
   */
  private applyAvailability(providerId: string, healthy: boolean): string[] {
    const affected: string[] = [];
    for (const model of this.registry.list()) {
      if (model.provider !== providerId) {
        continue;
      }
      try {
        if (healthy) {
          this.registry.markAvailable(model.id);
        } else {
          this.registry.markUnavailable(model.id);
        }
        affected.push(model.id);
      } catch {
        // Resilient: a registry mutation error for one model must not abort the
        // round (Req 2.10 — availability gating is best-effort per model).
      }
    }
    return affected;
  }
}
