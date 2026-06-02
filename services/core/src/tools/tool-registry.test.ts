/**
 * Unit tests for the Tool_Registry (Req 16.1, 16.2, 16.3).
 *
 * These example-based tests cover the registry's discrete behaviors and edge
 * cases: registering tools across categories and listing/resolving them
 * (Req 16.1), duplicate-registration and structurally-invalid-definition
 * handling, the unknown-tool error, argument validation success and failure
 * (Req 16.2), Allow_List gating and permission-filtered discovery (Req 16.3),
 * and the fail-closed ordering of `invoke`.
 *
 * They wire the real {@link ToolRegistry} to the in-memory sample tools in
 * `./fakes.js`, so they exercise the genuine registry with no real tool side
 * effects.
 */

import { describe, expect, it } from 'vitest';

import {
  DuplicateToolError,
  InvalidToolDefinitionError,
  ToolInputValidationError,
  ToolNotAllowedError,
  UnknownToolError,
} from './errors.js';
import { RecordingHandler, SAMPLE_TOOLS, makeTool, sampleRegistry } from './fakes.js';
import { ToolRegistry } from './tool-registry.js';
import { TOOL_CATEGORIES } from './types.js';

describe('ToolRegistry registration and discovery (Req 16.1)', () => {
  it('registers tools across every category and lists them in order', () => {
    const registry = sampleRegistry();
    const ids = registry.list().map((t) => t.id);
    expect(ids).toEqual(SAMPLE_TOOLS.map((t) => t.id));
  });

  it('lists handler-free descriptors (never exposes the handler)', () => {
    const registry = sampleRegistry();
    for (const descriptor of registry.list()) {
      expect(descriptor).not.toHaveProperty('handler');
      expect(descriptor.parameters).toBeDefined();
    }
  });

  it('covers every category exactly once and filters discovery by category', () => {
    const registry = sampleRegistry();
    for (const category of TOOL_CATEGORIES) {
      const inCategory = registry.list({ category });
      expect(inCategory).toHaveLength(1);
      expect(inCategory[0]?.category).toBe(category);
    }
  });

  it('resolves a registered tool by id', () => {
    const registry = sampleRegistry();
    const tool = registry.resolve('web_search');
    expect(tool.id).toBe('web_search');
    expect(tool.category).toBe('web');
    expect(typeof tool.handler).toBe('function');
  });

  it('reports membership with has()', () => {
    const registry = sampleRegistry();
    expect(registry.has('sql_query')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });
});

describe('ToolRegistry duplicate and invalid registration', () => {
  it('rejects a second registration under the same id', () => {
    const registry = new ToolRegistry([makeTool({ id: 'dup' })]);
    expect(() => registry.register(makeTool({ id: 'dup' }))).toThrow(DuplicateToolError);
  });

  it('rejects a tool with an empty id', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(makeTool({ id: '' }))).toThrow(InvalidToolDefinitionError);
  });

  it('rejects a tool with an unknown category', () => {
    const registry = new ToolRegistry();
    const bad = { ...makeTool({ id: 'x' }), category: 'bogus' } as unknown as Parameters<
      ToolRegistry['register']
    >[0];
    expect(() => registry.register(bad)).toThrow(InvalidToolDefinitionError);
  });

  it('rejects a tool with a non-callable handler', () => {
    const registry = new ToolRegistry();
    const bad = { ...makeTool({ id: 'x' }), handler: 'not a function' } as unknown as Parameters<
      ToolRegistry['register']
    >[0];
    expect(() => registry.register(bad)).toThrow(InvalidToolDefinitionError);
  });

  it('projects a duplicate error to a conflict PlatformError', () => {
    const error = new DuplicateToolError('dup');
    const platform = error.toPlatformError('corr-1');
    expect(platform.category).toBe('conflict');
    expect(platform.code).toBe('TOOL_ALREADY_REGISTERED');
    expect(platform.details).toEqual({ toolId: 'dup' });
  });
});

describe('ToolRegistry unknown-tool handling (Req 16.2)', () => {
  it('throws UnknownToolError when resolving an unregistered tool', () => {
    const registry = sampleRegistry();
    expect(() => registry.resolve('ghost')).toThrow(UnknownToolError);
  });

  it('throws UnknownToolError when validating against an unregistered tool', () => {
    const registry = sampleRegistry();
    expect(() => registry.validateInput('ghost', {})).toThrow(UnknownToolError);
  });

  it('projects an unknown-tool error to a not_found PlatformError', () => {
    const platform = new UnknownToolError('ghost').toPlatformError('corr-2');
    expect(platform.category).toBe('not_found');
    expect(platform.code).toBe('TOOL_NOT_FOUND');
  });
});

describe('ToolRegistry argument validation (Req 16.2)', () => {
  it('accepts input that satisfies the schema', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('web_search', { query: 'hello', maxResults: 5 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects input missing a required property', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('web_search', { maxResults: 5 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/query')).toBe(true);
  });

  it('rejects input with the wrong type', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('web_search', { query: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/query')).toBe(true);
  });

  it('rejects an out-of-range numeric constraint', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('web_search', { query: 'q', maxResults: 999 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/maxResults')).toBe(true);
  });

  it('rejects an unexpected additional property', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('web_search', { query: 'q', extra: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/extra')).toBe(true);
  });

  it('rejects an enum value outside the allowed set', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('run_code', { language: 'ruby', source: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/language')).toBe(true);
  });

  it('rejects a string that violates a pattern', () => {
    const registry = sampleRegistry();
    const result = registry.validateInput('github_issue', { repo: 'no-slash', title: 't' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/repo')).toBe(true);
  });
});

describe('ToolRegistry Allow_List gating (Req 16.3)', () => {
  it('permits exactly the tools on the Allow_List (fail-closed)', () => {
    const registry = sampleRegistry();
    expect(registry.isAllowed('web_search', ['web_search', 'sql_query'])).toBe(true);
    expect(registry.isAllowed('run_code', ['web_search', 'sql_query'])).toBe(false);
  });

  it('permits nothing under an empty Allow_List', () => {
    const registry = sampleRegistry();
    expect(registry.isAllowed('web_search', [])).toBe(false);
  });

  it('filters discovery to the Allow_List', () => {
    const registry = sampleRegistry();
    const allowList = ['web_search', 'github_issue'];
    const ids = registry.list({ allowList }).map((t) => t.id);
    expect(ids).toEqual(['web_search', 'github_issue']);
  });

  it('intersects category and Allow_List filters', () => {
    const registry = sampleRegistry();
    const ids = registry
      .list({ category: 'web', allowList: ['sql_query', 'github_issue'] })
      .map((t) => t.id);
    expect(ids).toEqual([]); // web_search is the only web tool, but it's not allow-listed
  });
});

describe('ToolRegistry.invoke fail-closed dispatch (Req 16.2, 16.3)', () => {
  it('dispatches to the handler when allow-listed and valid', async () => {
    const recorder = new RecordingHandler();
    const registry = new ToolRegistry([
      makeTool({
        id: 'echo',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        handler: recorder.handler,
      }),
    ]);

    const result = await registry.invoke('echo', { value: 'hi' }, ['echo'], { runId: 'run-1' });

    expect(result).toEqual({ echoed: { value: 'hi' } });
    expect(recorder.count).toBe(1);
    expect(recorder.invocations[0]?.context.runId).toBe('run-1');
  });

  it('denies a tool not on the Allow_List before touching the handler (Req 16.3)', async () => {
    const recorder = new RecordingHandler();
    const registry = new ToolRegistry([makeTool({ id: 'echo', handler: recorder.handler })]);

    await expect(registry.invoke('echo', { value: 'hi' }, [])).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
    expect(recorder.count).toBe(0);
  });

  it('rejects invalid input before touching the handler (Req 16.2)', async () => {
    const recorder = new RecordingHandler();
    const registry = new ToolRegistry([makeTool({ id: 'echo', handler: recorder.handler })]);

    const error = await registry
      .invoke('echo', { value: 123 }, ['echo'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInputValidationError);
    expect((error as ToolInputValidationError).violations.length).toBeGreaterThan(0);
    expect(recorder.count).toBe(0);

    const platform = (error as ToolInputValidationError).toPlatformError('corr-3');
    expect(platform.category).toBe('validation');
    expect(platform.code).toBe('TOOL_INPUT_INVALID');
  });

  it('checks the Allow_List before validating input (denial precedes validation)', async () => {
    const registry = new ToolRegistry([makeTool({ id: 'echo' })]);
    // Input is invalid AND the tool is not allow-listed → the Allow_List denial wins.
    await expect(registry.invoke('echo', { value: 123 }, [])).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
  });

  it('throws UnknownToolError when invoking an unregistered tool', async () => {
    const registry = sampleRegistry();
    await expect(registry.invoke('ghost', {}, ['ghost'])).rejects.toBeInstanceOf(UnknownToolError);
  });
});
