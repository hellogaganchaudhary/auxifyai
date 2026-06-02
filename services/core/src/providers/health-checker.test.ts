/**
 * Unit tests for the provider health checker and availability gating (Req 2.10,
 * task 5.4).
 *
 * These cover concrete examples and edge cases of the health-gating behavior:
 * a failing provider marks its models unavailable, a later success restores
 * them, a provider that throws is treated as unhealthy, one provider's failure
 * never blocks the others, and only the failing provider's models are gated.
 * The periodic loop is exercised through an injected fake scheduler so no real
 * timers are involved. The universally-quantified property test for health-gated
 * availability (Property 10) is task 5.5's dedicated property test.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HealthStatus } from '@auxify/types';

import {
  ConfigModelRegistry,
  ProviderHealthChecker,
  type AIProvider,
  type ModelConfig,
  type RegistryConfig,
  type SchedulerLike,
} from './index.js';

/** Build a chat {@link ModelConfig} for `provider` with sensible defaults. */
function model(id: string, provider: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id,
    provider,
    providerModelId: `${id}-deployment`,
    displayName: id,
    modality: 'chat',
    tier: 'standard',
    maxTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.001, per1kOutputTokens: 0.002 },
    ...overrides,
  };
}

/** Build a {@link RegistryConfig} declaring the providers referenced by `models`. */
function configFor(models: ModelConfig[]): RegistryConfig {
  const providers = [...new Set(models.map((m) => m.provider))].map((id) => ({ id }));
  return { providers, models };
}

/**
 * A minimal {@link AIProvider} fake whose health can be toggled between healthy,
 * unhealthy, and throwing. Only `healthCheck`/`providerId` matter to the checker;
 * the remaining members throw so an accidental call is caught loudly.
 */
class FakeProvider implements AIProvider {
  /** Number of times {@link FakeProvider.healthCheck} has been invoked. */
  checks = 0;

  /** Health mode: report healthy, report unhealthy, or reject the call. */
  private mode: 'healthy' | 'unhealthy' | 'throws';

  constructor(
    readonly providerId: string,
    mode: 'healthy' | 'unhealthy' | 'throws' = 'healthy',
  ) {
    this.mode = mode;
  }

  /** Toggle the provider's health mode between rounds (test hook). */
  setMode(mode: 'healthy' | 'unhealthy' | 'throws'): void {
    this.mode = mode;
  }

  async healthCheck(): Promise<HealthStatus> {
    this.checks += 1;
    if (this.mode === 'throws') {
      throw new Error(`${this.providerId} health probe exploded`);
    }
    return {
      providerId: this.providerId,
      healthy: this.mode === 'healthy',
      checkedAt: '2025-01-01T00:00:00.000Z',
      ...(this.mode === 'unhealthy' ? { detail: `${this.providerId} is down` } : {}),
    };
  }

  // Unused by the health checker; present to satisfy the AIProvider contract.
  chat(): AsyncIterable<never> {
    throw new Error('not implemented');
  }
  embed(): never {
    throw new Error('not implemented');
  }
  generateImage(): never {
    throw new Error('not implemented');
  }
  realtime(): never {
    throw new Error('not implemented');
  }
  listModels(): never {
    throw new Error('not implemented');
  }
}

/** Map model id -> availability, for concise assertions over the registry. */
function availability(registry: ConfigModelRegistry): Record<string, boolean> {
  return Object.fromEntries(registry.list().map((m) => [m.id, m.available]));
}

describe('ProviderHealthChecker.checkAll availability gating (Req 2.10)', () => {
  it('marks all of a failing provider models unavailable, then available again on recovery', async () => {
    const registry = new ConfigModelRegistry(
      configFor([model('a1', 'alpha'), model('a2', 'alpha')]),
    );
    const provider = new FakeProvider('alpha', 'unhealthy');
    const checker = new ProviderHealthChecker([provider], registry);

    // Initial state is available.
    expect(availability(registry)).toEqual({ a1: true, a2: true });

    // A failing check gates every model the provider serves.
    await checker.checkAll();
    expect(availability(registry)).toEqual({ a1: false, a2: false });

    // A later succeeding check restores them.
    provider.setMode('healthy');
    await checker.checkAll();
    expect(availability(registry)).toEqual({ a1: true, a2: true });
  });

  it('treats a thrown healthCheck() as unhealthy and gates the models', async () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const provider = new FakeProvider('alpha', 'throws');
    const checker = new ProviderHealthChecker([provider], registry);

    const [result] = await checker.checkAll();

    expect(registry.get('a1').available).toBe(false);
    expect(result?.healthy).toBe(false);
    expect(result?.detail).toContain('exploded');
    expect(result?.affectedModelIds).toEqual(['a1']);
  });

  it('gates only the failing provider models, leaving healthy providers untouched', async () => {
    const registry = new ConfigModelRegistry(
      configFor([model('a1', 'alpha'), model('b1', 'beta'), model('b2', 'beta')]),
    );
    const alpha = new FakeProvider('alpha', 'unhealthy');
    const beta = new FakeProvider('beta', 'healthy');
    const checker = new ProviderHealthChecker([alpha, beta], registry);

    await checker.checkAll();

    expect(availability(registry)).toEqual({ a1: false, b1: true, b2: true });
  });

  it('is resilient: one provider that throws does not prevent checking the others', async () => {
    const registry = new ConfigModelRegistry(
      configFor([model('a1', 'alpha'), model('b1', 'beta')]),
    );
    const alpha = new FakeProvider('alpha', 'throws');
    const beta = new FakeProvider('beta', 'unhealthy');
    const checker = new ProviderHealthChecker([alpha, beta], registry);

    const results = await checker.checkAll();

    // Both providers were polled and both sets of models were gated.
    expect(alpha.checks).toBe(1);
    expect(beta.checks).toBe(1);
    expect(availability(registry)).toEqual({ a1: false, b1: false });
    expect(results.map((r) => r.providerId)).toEqual(['alpha', 'beta']);
  });

  it('ignores models served by providers not registered with the checker', async () => {
    const registry = new ConfigModelRegistry(
      configFor([model('a1', 'alpha'), model('g1', 'ghost')]),
    );
    const alpha = new FakeProvider('alpha', 'unhealthy');
    const checker = new ProviderHealthChecker([alpha], registry);

    await checker.checkAll();

    // The ghost provider's model is never touched (no provider polls it).
    expect(availability(registry)).toEqual({ a1: false, g1: true });
  });

  it('returns per-provider results in provider order with affected model ids', async () => {
    const registry = new ConfigModelRegistry(
      configFor([model('a1', 'alpha'), model('a2', 'alpha'), model('b1', 'beta')]),
    );
    const checker = new ProviderHealthChecker(
      [new FakeProvider('alpha', 'unhealthy'), new FakeProvider('beta', 'healthy')],
      registry,
    );

    const results = await checker.checkAll();

    expect(results).toEqual([
      {
        providerId: 'alpha',
        healthy: false,
        affectedModelIds: ['a1', 'a2'],
        detail: 'alpha is down',
      },
      { providerId: 'beta', healthy: true, affectedModelIds: ['b1'] },
    ]);
  });

  it('reflects the most recent outcome across an alternating sequence of checks', async () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const provider = new FakeProvider('alpha', 'healthy');
    const checker = new ProviderHealthChecker([provider], registry);

    for (const mode of ['unhealthy', 'healthy', 'throws', 'healthy'] as const) {
      provider.setMode(mode);
      await checker.checkAll();
      expect(registry.get('a1').available).toBe(mode === 'healthy');
    }
  });

  it('handles an empty provider set without touching the registry', async () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const checker = new ProviderHealthChecker([], registry);

    const results = await checker.checkAll();

    expect(results).toEqual([]);
    expect(registry.get('a1').available).toBe(true);
  });
});

describe('ProviderHealthChecker periodic loop (Req 2.10)', () => {
  /** A controllable {@link SchedulerLike} that fires on demand instead of via timers. */
  function fakeScheduler(): {
    scheduler: SchedulerLike;
    tick: () => void;
    cancelled: () => boolean;
  } {
    let run: (() => void) | undefined;
    let cancelled = false;
    return {
      scheduler: {
        schedule(fn) {
          run = fn;
          return () => {
            cancelled = true;
            run = undefined;
          };
        },
      },
      tick: () => run?.(),
      cancelled: () => cancelled,
    };
  }

  it('start() schedules checkAll on each tick and stop() cancels it', async () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const provider = new FakeProvider('alpha', 'unhealthy');
    const { scheduler, tick, cancelled } = fakeScheduler();
    const checker = new ProviderHealthChecker([provider], registry, { scheduler });

    checker.start(1000);
    expect(checker.running).toBe(true);

    // One scheduled tick runs a full round.
    tick();
    await vi.waitFor(() => expect(registry.get('a1').available).toBe(false));
    expect(provider.checks).toBe(1);

    checker.stop();
    expect(checker.running).toBe(false);
    expect(cancelled()).toBe(true);
  });

  it('start() is idempotent: scheduling only happens once while running', () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const { scheduler } = fakeScheduler();
    const scheduleSpy = vi.spyOn(scheduler, 'schedule');
    const checker = new ProviderHealthChecker([new FakeProvider('alpha')], registry, { scheduler });

    checker.start(1000);
    checker.start(1000);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-positive interval', () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const checker = new ProviderHealthChecker([new FakeProvider('alpha')], registry);

    expect(() => checker.start(0)).toThrow(RangeError);
    expect(() => checker.start(-5)).toThrow(RangeError);
    expect(checker.running).toBe(false);
  });

  it('stop() is a no-op when not running', () => {
    const registry = new ConfigModelRegistry(configFor([model('a1', 'alpha')]));
    const checker = new ProviderHealthChecker([new FakeProvider('alpha')], registry);

    expect(() => checker.stop()).not.toThrow();
    expect(checker.running).toBe(false);
  });
});
