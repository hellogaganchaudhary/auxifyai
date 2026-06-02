/**
 * Unit tests for the config-driven Model_Registry (Req 2.2, 2.6, 2.7, 2.10).
 *
 * These cover specific examples and edge cases: loading from configuration,
 * retrieval and listing with full capability metadata, availability gating, and
 * validation of malformed configs. The universally-quantified property test for
 * config-driven onboarding completeness (Property 9) is task 5.2's dedicated
 * property test.
 */

import { describe, expect, it } from 'vitest';

import {
  ConfigModelRegistry,
  DEFAULT_MODELS,
  InvalidRegistryConfigError,
  ModelNotFoundError,
  defaultRegistryConfig,
  type ModelConfig,
  type RegistryConfig,
} from './index.js';

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1',
    provider: 'azure',
    providerModelId: 'deployment-1',
    displayName: 'Model One',
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

function config(models: ModelConfig[]): RegistryConfig {
  return { providers: [{ id: 'azure' }, { id: 'bedrock' }], models };
}

describe('ConfigModelRegistry.load', () => {
  it('loads every configured model so it is retrievable by id and present in list()', () => {
    const registry = new ConfigModelRegistry();
    registry.load(config([model({ id: 'a' }), model({ id: 'b' })]));
    expect(registry.list().map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(registry.get('a').id).toBe('a');
    expect(registry.get('b').id).toBe('b');
  });

  it('preserves config order in list()', () => {
    const registry = new ConfigModelRegistry();
    registry.load(config([model({ id: 'z' }), model({ id: 'a' }), model({ id: 'm' })]));
    expect(registry.list().map((m) => m.id)).toEqual(['z', 'a', 'm']);
  });

  it('replaces prior state on a subsequent load', () => {
    const registry = new ConfigModelRegistry(config([model({ id: 'old' })]));
    registry.load(config([model({ id: 'new' })]));
    expect(registry.list().map((m) => m.id)).toEqual(['new']);
    expect(() => registry.get('old')).toThrow(ModelNotFoundError);
  });

  it('exposes modality, tier, costs, and capability flags for each model (Req 2.6, 2.7)', () => {
    const registry = new ConfigModelRegistry(
      config([
        model({
          id: 'vision-model',
          modality: 'chat',
          tier: 'premium',
          maxTokens: 200_000,
          supportsVision: true,
          supportsTools: true,
          supportsReasoning: true,
          cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.03 },
        }),
      ]),
    );
    const info = registry.get('vision-model');
    expect(info).toMatchObject({
      provider: 'azure',
      providerModelId: 'deployment-1',
      modality: 'chat',
      tier: 'premium',
      maxTokens: 200_000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.03 },
      available: true,
    });
  });

  it('defaults availability to true and honors an explicit initial availability', () => {
    const registry = new ConfigModelRegistry(
      config([model({ id: 'on' }), model({ id: 'off', available: false })]),
    );
    expect(registry.get('on').available).toBe(true);
    expect(registry.get('off').available).toBe(false);
  });

  it('accepts a minimal config with models only (no providers declared)', () => {
    const registry = new ConfigModelRegistry();
    registry.load({ models: [model({ id: 'solo', provider: 'whatever' })] });
    expect(registry.get('solo').provider).toBe('whatever');
  });
});

describe('ConfigModelRegistry.load validation', () => {
  it('rejects duplicate model ids', () => {
    const registry = new ConfigModelRegistry();
    expect(() => registry.load(config([model({ id: 'dup' }), model({ id: 'dup' })]))).toThrow(
      InvalidRegistryConfigError,
    );
  });

  it('rejects a model referencing an undeclared provider', () => {
    const registry = new ConfigModelRegistry();
    expect(() =>
      registry.load(config([model({ id: 'x', provider: 'ghost' })])),
    ).toThrow(InvalidRegistryConfigError);
  });

  it('rejects an invalid modality', () => {
    const registry = new ConfigModelRegistry();
    expect(() =>
      registry.load(config([model({ modality: 'bogus' as ModelConfig['modality'] })])),
    ).toThrow(InvalidRegistryConfigError);
  });

  it('rejects an invalid tier', () => {
    const registry = new ConfigModelRegistry();
    expect(() =>
      registry.load(config([model({ tier: 'gold' as ModelConfig['tier'] })])),
    ).toThrow(InvalidRegistryConfigError);
  });

  it('rejects non-positive maxTokens and negative costs', () => {
    const registry = new ConfigModelRegistry();
    expect(() => registry.load(config([model({ maxTokens: 0 })]))).toThrow(
      InvalidRegistryConfigError,
    );
    expect(() =>
      registry.load(config([model({ cost: { per1kInputTokens: -1, per1kOutputTokens: 0 } })])),
    ).toThrow(InvalidRegistryConfigError);
  });

  it('rejects a missing models array', () => {
    const registry = new ConfigModelRegistry();
    expect(() => registry.load({} as RegistryConfig)).toThrow(InvalidRegistryConfigError);
  });

  it('leaves the prior catalog intact when a load fails', () => {
    const registry = new ConfigModelRegistry(config([model({ id: 'keep' })]));
    expect(() => registry.load(config([model({ id: 'dup' }), model({ id: 'dup' })]))).toThrow();
    // Atomic load: the good prior state survives a failed reload.
    expect(registry.list().map((m) => m.id)).toEqual(['keep']);
  });
});

describe('ConfigModelRegistry availability gating (Req 2.10)', () => {
  it('marks a model unavailable and available again', () => {
    const registry = new ConfigModelRegistry(config([model({ id: 'm' })]));
    expect(registry.get('m').available).toBe(true);
    registry.markUnavailable('m');
    expect(registry.get('m').available).toBe(false);
    registry.markAvailable('m');
    expect(registry.get('m').available).toBe(true);
  });

  it('throws for availability changes to an unknown model', () => {
    const registry = new ConfigModelRegistry(config([model({ id: 'm' })]));
    expect(() => registry.markUnavailable('ghost')).toThrow(ModelNotFoundError);
    expect(() => registry.markAvailable('ghost')).toThrow(ModelNotFoundError);
  });
});

describe('ConfigModelRegistry immutability of returned records', () => {
  it('get() returns a defensive copy that does not mutate the catalog', () => {
    const registry = new ConfigModelRegistry(config([model({ id: 'm' })]));
    const info = registry.get('m');
    info.available = false;
    info.cost.per1kInputTokens = 999;
    // The registry's own record is unaffected by mutating the returned copy.
    expect(registry.get('m').available).toBe(true);
    expect(registry.get('m').cost.per1kInputTokens).toBe(0.001);
  });

  it('get() throws ModelNotFoundError for an unknown id', () => {
    const registry = new ConfigModelRegistry();
    expect(() => registry.get('nope')).toThrow(ModelNotFoundError);
  });
});

describe('defaultRegistryConfig (Req 2.3 launch catalog)', () => {
  it('loads cleanly into the registry', () => {
    const registry = new ConfigModelRegistry(defaultRegistryConfig);
    expect(registry.list().length).toBe(DEFAULT_MODELS.length);
  });

  it('includes GPT-family chat, reasoning, realtime, image, and Claude families', () => {
    const registry = new ConfigModelRegistry(defaultRegistryConfig);
    const byModality = (m: string) =>
      registry.list().filter((info) => info.modality === m);

    // GPT-family chat models.
    expect(registry.has('gpt-4o')).toBe(true);
    expect(registry.has('gpt-4o-mini')).toBe(true);
    // OpenAI reasoning models.
    expect(byModality('reasoning').length).toBeGreaterThan(0);
    expect(registry.get('o3').supportsReasoning).toBe(true);
    // Realtime models.
    expect(byModality('realtime').length).toBeGreaterThan(0);
    // Image-generation models.
    expect(byModality('image').length).toBeGreaterThan(0);
    // Claude Opus/Sonnet/Haiku families.
    expect(registry.has('claude-opus-4')).toBe(true);
    expect(registry.has('claude-sonnet-4')).toBe(true);
    expect(registry.has('claude-3-5-haiku')).toBe(true);
  });

  it('routes Claude models to bedrock and GPT/OpenAI models to azure (Req 2.4, 2.5)', () => {
    const registry = new ConfigModelRegistry(defaultRegistryConfig);
    expect(registry.get('claude-opus-4').provider).toBe('bedrock');
    expect(registry.get('gpt-4o').provider).toBe('azure');
    expect(registry.get('o3').provider).toBe('azure');
  });

  it('declares at least one vision-capable and one image-generation model (Req 2.8, 2.9)', () => {
    const registry = new ConfigModelRegistry(defaultRegistryConfig);
    expect(registry.list().some((m) => m.supportsVision)).toBe(true);
    expect(registry.list().some((m) => m.modality === 'image')).toBe(true);
  });
});
