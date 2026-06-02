/**
 * Property-based test for **Property 36: Tool invocations are schema-validated
 * and Allow_List-gated** (design "Property 36"; Req 16.2, 16.3).
 *
 * Validates: Requirements 16.2, 16.3
 *
 * Property 36 (design): _For any_ tool invocation, the input is accepted for
 * execution if and only if it satisfies the tool's input schema, and a tool
 * that is not on the agent's Allow_List is denied (and the denial recorded in
 * the run steps). Requirement 16.2 makes the Tool_Registry validate a tool's
 * input against the tool's schema *before* execution; Requirement 16.3 denies
 * the invocation of a tool not on the agent's Allow_List.
 *
 * This file exercises the real {@link ToolRegistry} from `./tool-registry.js`
 * (built in task 15.3) with a {@link RecordingHandler} so we can observe whether
 * the tool's handler actually ran. The independent oracle for "is this input
 * schema-valid?" is {@link validateAgainstSchema} applied to the *same* schema
 * and arguments — so the test never re-implements validation, it cross-checks
 * the dispatch decision against the validator the registry also relies on.
 *
 * Three properties are asserted across arbitrary tools, Allow_Lists, and
 * arguments:
 *   1. `invoke` dispatches to the handler *iff* the tool id is on the Allow_List
 *      AND the arguments satisfy the schema; otherwise it rejects with
 *      `ToolNotAllowedError` (not allow-listed) or `ToolInputValidationError`
 *      (allow-listed but invalid), and the handler never runs.
 *   2. The Allow_List gate runs *before* the schema gate: a non-allow-listed
 *      tool with deliberately-invalid arguments is rejected with
 *      `ToolNotAllowedError` (never `ToolInputValidationError`).
 *   3. Discovery is permission-filtered: `list({ allowList })` returns exactly
 *      the registered tools whose id is on the Allow_List, in registration order.
 *
 * Generators stay deliberately simple (objects of required/optional
 * string/number properties with `additionalProperties: false`) so both
 * schema-valid and schema-invalid argument objects are produced deterministically.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ToolInputValidationError, ToolNotAllowedError } from './errors.js';
import { RecordingHandler, makeTool } from './fakes.js';
import { validateAgainstSchema } from './schema.js';
import { ToolRegistry } from './tool-registry.js';
import type { JsonSchema } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** Candidate ids for the tool under test (small pool so Allow_Lists overlap). */
const TOOL_IDS = ['alpha_tool', 'beta_tool', 'gamma_tool'] as const;

/** Other registrable ids that are never the tool-under-test's id. */
const OTHER_IDS = ['x_tool', 'y_tool', 'z_tool'] as const;

/** A small pool of property names so generated schemas have stable, unique keys. */
const NAME_POOL = ['p1', 'p2', 'p3', 'p4', 'p5'] as const;

// ---------------------------------------------------------------------------
// Generated-schema model
// ---------------------------------------------------------------------------

/** One generated object property: a name, a JSON type, and whether it is required. */
interface GenProp {
  name: string;
  type: 'string' | 'number';
  required: boolean;
}

/** Build the {@link JsonSchema} described by a set of generated properties. */
function buildSchema(specs: readonly GenProp[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const spec of specs) {
    properties[spec.name] = { type: spec.type };
  }
  return {
    type: 'object',
    properties,
    required: specs.filter((s) => s.required).map((s) => s.name),
    additionalProperties: false,
  };
}

/** A generator of a single schema-valid value for a property type. */
function valueArbForType(type: 'string' | 'number'): fc.Arbitrary<unknown> {
  return type === 'string' ? fc.string() : fc.integer();
}

/** 1..4 uniquely-named properties, each string|number and required or not. */
const specsArb: fc.Arbitrary<GenProp[]> = fc
  .uniqueArray(fc.constantFrom(...NAME_POOL), { minLength: 1, maxLength: 4 })
  .chain((names) =>
    fc.tuple(
      ...names.map((name) =>
        fc
          .record({
            type: fc.constantFrom<'string' | 'number'>('string', 'number'),
            required: fc.boolean(),
          })
          .map((r): GenProp => ({ name, type: r.type, required: r.required })),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Argument generators (a healthy mix of schema-valid and schema-invalid)
// ---------------------------------------------------------------------------

/**
 * An object that satisfies the schema: every required property present with a
 * correctly-typed value, optional properties present-or-absent, no extras.
 */
function validArgsArb(specs: readonly GenProp[]): fc.Arbitrary<Record<string, unknown>> {
  const perProp = specs.map((spec) =>
    fc
      .record({
        present: spec.required ? fc.constant(true) : fc.boolean(),
        value: valueArbForType(spec.type),
      })
      .map(({ present, value }) => ({ name: spec.name, present, value })),
  );
  return fc.tuple(...perProp).map((decisions) => {
    const obj: Record<string, unknown> = {};
    for (const d of decisions) {
      if (d.present) obj[d.name] = d.value;
    }
    return obj;
  });
}

/**
 * A schema-*invalid* object derived from a valid one via a single mutation:
 * an extra property (`additionalProperties: false`), a wrong-typed declared
 * property, or a removed required property. Each mutation is guaranteed to
 * violate the schema built by {@link buildSchema}.
 */
function corruptArb(specs: readonly GenProp[]): fc.Arbitrary<Record<string, unknown>> {
  return validArgsArb(specs).chain((valid) => {
    const mutations: fc.Arbitrary<Record<string, unknown>>[] = [
      // Extra, undeclared property — rejected by additionalProperties: false.
      fc.string().map((extra) => ({ ...valid, unexpected_extra: extra })),
    ];
    if (specs.length > 0) {
      // Wrong-typed declared property (string<->number swap).
      mutations.push(
        fc.constantFrom(...specs).chain((spec) =>
          (spec.type === 'string' ? fc.integer() : fc.string()).map((wrong) => ({
            ...valid,
            [spec.name]: wrong,
          })),
        ),
      );
    }
    const requiredSpecs = specs.filter((s) => s.required);
    if (requiredSpecs.length > 0) {
      // Drop a required property.
      mutations.push(
        fc.constantFrom(...requiredSpecs).map((spec) => {
          const copy: Record<string, unknown> = { ...valid };
          delete copy[spec.name];
          return copy;
        }),
      );
    }
    return fc.oneof(...mutations);
  });
}

/** Non-object junk that always fails the top-level `type: 'object'` check. */
const junkArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer()),
);

/** A mix of valid, corrupted, and junk arguments for a given schema. */
function argsArb(specs: readonly GenProp[]): fc.Arbitrary<unknown> {
  return fc.oneof(
    { weight: 3, arbitrary: validArgsArb(specs) },
    { weight: 4, arbitrary: corruptArb(specs) },
    { weight: 1, arbitrary: junkArb },
  );
}

// ---------------------------------------------------------------------------
// Scenario generator
// ---------------------------------------------------------------------------

interface Scenario {
  toolId: string;
  schema: JsonSchema;
  allowList: string[];
  args: unknown;
}

/**
 * A tool id, the schema it is registered with, an Allow_List that sometimes
 * contains the tool id (and sometimes other ids), and arbitrary arguments.
 */
const scenarioArb: fc.Arbitrary<Scenario> = specsArb.chain((specs) => {
  const schema = buildSchema(specs);
  return fc
    .record({
      toolId: fc.constantFrom(...TOOL_IDS),
      allowList: fc.subarray([...TOOL_IDS, ...OTHER_IDS]),
      args: argsArb(specs),
    })
    .map((r) => ({ toolId: r.toolId, schema, allowList: r.allowList, args: r.args }));
});

// ---------------------------------------------------------------------------
// Property 36
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 36: Tool invocations are schema-validated and Allow_List-gated', () => {
  it('invoke dispatches the handler iff the tool is allow-listed AND the input is schema-valid (Validates: Requirements 16.2, 16.3)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ toolId, schema, allowList, args }) => {
        const recorder = new RecordingHandler();
        const registry = new ToolRegistry([
          makeTool({ id: toolId, parameters: schema, handler: recorder.handler }),
        ]);

        // Independent oracles for the two gates.
        const allowed = allowList.includes(toolId);
        const validation = validateAgainstSchema(args, schema);

        if (!allowed) {
          // Allow_List gate fails first — denied regardless of input validity (Req 16.3).
          await expect(registry.invoke(toolId, args, allowList)).rejects.toBeInstanceOf(
            ToolNotAllowedError,
          );
          expect(recorder.count).toBe(0);
        } else if (!validation.valid) {
          // Allow-listed but the schema rejects the input (Req 16.2).
          const error = await registry.invoke(toolId, args, allowList).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ToolInputValidationError);
          expect((error as ToolInputValidationError).toolId).toBe(toolId);
          // The error carries exactly the violations the validator reported.
          expect((error as ToolInputValidationError).violations).toEqual(validation.errors);
          expect(recorder.count).toBe(0);
        } else {
          // Allow-listed AND valid — the handler runs exactly once with the input.
          const result = await registry.invoke(toolId, args, allowList, { runId: 'run-x' });
          expect(recorder.count).toBe(1);
          expect(recorder.invocations[0]?.input).toBe(args);
          expect(recorder.invocations[0]?.context.runId).toBe('run-x');
          expect(result).toEqual({ echoed: args });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('denies a non-allow-listed tool before schema validation, even when the arguments are invalid (Validates: Requirements 16.3)', async () => {
    const gateFirstArb = specsArb.chain((specs) => {
      const schema = buildSchema(specs);
      return fc
        .record({
          toolId: fc.constantFrom(...TOOL_IDS),
          // Draws only from OTHER_IDS, so it can never contain a TOOL_ID.
          allowList: fc.subarray<string>([...OTHER_IDS]),
          args: fc.oneof(corruptArb(specs), junkArb),
        })
        .map((r) => ({ toolId: r.toolId, schema, allowList: r.allowList, args: r.args }));
    });

    await fc.assert(
      fc.asyncProperty(gateFirstArb, async ({ toolId, schema, allowList, args }) => {
        // Confirm the two preconditions that make this a genuine ordering test:
        // the tool is NOT allow-listed, and the arguments WOULD fail the schema.
        fc.pre(!allowList.includes(toolId));
        fc.pre(!validateAgainstSchema(args, schema).valid);

        const recorder = new RecordingHandler();
        const registry = new ToolRegistry([
          makeTool({ id: toolId, parameters: schema, handler: recorder.handler }),
        ]);

        // The Allow_List denial wins over the (also-failing) schema gate.
        const error = await registry.invoke(toolId, args, allowList).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ToolNotAllowedError);
        expect(error).not.toBeInstanceOf(ToolInputValidationError);
        expect(recorder.count).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('list({ allowList }) returns exactly the allow-listed registered tools, in registration order (Validates: Requirements 16.3)', () => {
    const idPool = [...TOOL_IDS, ...OTHER_IDS];
    const discoveryArb = fc
      .uniqueArray(fc.constantFrom(...idPool), { minLength: 1, maxLength: idPool.length })
      .chain((registeredIds) =>
        fc
          // Include some never-registered ids to prove they are filtered out too.
          .subarray([...registeredIds, 'never_registered_a', 'never_registered_b'])
          .map((allowList) => ({ registeredIds, allowList })),
      );

    fc.assert(
      fc.property(discoveryArb, ({ registeredIds, allowList }) => {
        const registry = new ToolRegistry(registeredIds.map((id) => makeTool({ id })));
        const listedIds = registry.list({ allowList }).map((t) => t.id);

        // Permission-filtered discovery: only allow-listed *registered* tools, in order.
        const expected = registeredIds.filter((id) => allowList.includes(id));
        expect(listedIds).toEqual(expected);
        // Nothing outside the Allow_List ever leaks into discovery.
        expect(listedIds.every((id) => allowList.includes(id))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
