import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AUXIFY_TYPES_PACKAGE,
  ROLES,
  RESOURCE_TYPES,
  ACTIONS,
  MODEL_TIERS,
  MODEL_MODALITIES,
  CONTENT_BLOCK_TYPES,
  ERROR_CATEGORIES,
} from './index';

// Toolchain smoke test: confirms Vitest runs and `fast-check` property
// testing is wired up (a minimum of 100 generated iterations per property).
describe('@auxify/types toolchain', () => {
  it('exposes the package marker', () => {
    expect(AUXIFY_TYPES_PACKAGE).toBe('@auxify/types');
  });

  it('runs fast-check property tests (string concatenation length)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return (a + b).length === a.length + b.length;
      }),
      { numRuns: 100 },
    );
  });
});

// Confirms the barrel re-exports the domain enumerations from each module so
// downstream packages (SDK, core, web) get a single import surface (Req 46.8).
describe('@auxify/types barrel re-exports', () => {
  it('re-exports the domain enumerations from every module', () => {
    expect(ROLES).toContain('viewer');
    expect(RESOURCE_TYPES).toContain('conversation');
    expect(ACTIONS).toContain('read');
    expect(MODEL_TIERS).toEqual(['economy', 'standard', 'premium']);
    expect(MODEL_MODALITIES).toContain('chat');
    expect(CONTENT_BLOCK_TYPES).toContain('markdown');
    expect(ERROR_CATEGORIES).toContain('authorization');
  });
});
