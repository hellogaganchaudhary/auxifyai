/**
 * Agent-template discovery and creation-from-template (Req 16.4, 16.5).
 *
 * This module exposes the two operations the platform offers over the pre-built
 * catalog:
 *   - {@link getTemplate} — the throwing discovery accessor: resolve a template
 *     by id or fail closed with an {@link UnknownAgentTemplateError} (Req 16.4);
 *     and
 *   - {@link createFromTemplate} — instantiate a concrete {@link AgentDefinition}
 *     from a template, **copying** its system prompt, allowed tools, model, and
 *     safety limits (Req 16.5, Property 37), with optional, validated
 *     {@link AgentTemplateOverrides} layered on top.
 *
 * Creation is a pure function: it never mutates the source template (it deep-
 * copies every field, so the returned definition shares no array/object
 * reference with the template) and it records the source template's id as the
 * definition's `templateId` provenance link. Overrides are validated up front;
 * an invalid override fails closed with an {@link InvalidTemplateOverrideError}
 * naming the offending field, and an empty/omitted overrides object copies the
 * template verbatim (Property 37).
 */

import { findTemplate } from './catalog.js';
import { InvalidTemplateOverrideError, UnknownAgentTemplateError } from './errors.js';
import {
  SAFETY_LIMIT_CEILINGS,
  type AgentDefinition,
  type AgentTemplate,
  type AgentTemplateOverrides,
  type SafetyLimits,
} from './types.js';

/**
 * Resolve a pre-built agent template by id, failing closed when absent
 * (Req 16.4).
 *
 * The throwing companion to {@link import('./catalog.js').findTemplate}; use it
 * when an unknown id is an error (e.g. a create request naming a non-existent
 * template).
 *
 * @param templateId The template id to resolve.
 * @returns A fresh clone of the matching template.
 * @throws UnknownAgentTemplateError if no catalog template has that id.
 */
export function getTemplate(templateId: string): AgentTemplate {
  const template = findTemplate(templateId);
  if (template === undefined) throw new UnknownAgentTemplateError(templateId);
  return template;
}

/**
 * Validate and normalize an overridden, non-blank string field.
 *
 * @param field The override field name, for error reporting.
 * @param value The candidate value.
 * @returns The trimmed value when non-blank.
 * @throws InvalidTemplateOverrideError if the value is blank.
 */
function requireNonBlank(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidTemplateOverrideError(field, 'must not be blank');
  }
  return trimmed;
}

/**
 * Validate an overridden tool-id Allow_List: every id must be a non-blank
 * string and the list must contain no duplicates (Req 16.3, 16.5).
 *
 * @param tools The candidate Allow_List.
 * @returns A fresh, trimmed copy of the Allow_List.
 * @throws InvalidTemplateOverrideError on a blank id or a duplicate id.
 */
function validateAllowedTools(tools: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const id = raw.trim();
    if (id.length === 0) {
      throw new InvalidTemplateOverrideError('allowedTools', 'tool ids must not be blank');
    }
    if (seen.has(id)) {
      throw new InvalidTemplateOverrideError('allowedTools', `duplicate tool id "${id}"`);
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Merge a partial {@link SafetyLimits} override onto the template's limits,
 * validating every supplied limit (Req 15.2-15.4, 16.5).
 *
 * Only the limits present in `override` are replaced; the rest are inherited
 * from `base`. Each supplied limit must be a positive finite number, and the
 * step/duration limits may not exceed the platform ceilings
 * ({@link SAFETY_LIMIT_CEILINGS}) so a template can never request a run that
 * outlives the platform's guarantees.
 *
 * @param base The template's safety limits.
 * @param override The partial override (may be `undefined`).
 * @returns A fresh, fully-populated {@link SafetyLimits}.
 * @throws InvalidTemplateOverrideError on a non-positive or over-ceiling limit.
 */
function mergeSafetyLimits(
  base: SafetyLimits,
  override: Partial<SafetyLimits> | undefined,
): SafetyLimits {
  const merged: SafetyLimits = { ...base };
  if (override === undefined) return merged;

  if (override.maxSteps !== undefined) {
    merged.maxSteps = validateLimit(
      'safetyLimits.maxSteps',
      override.maxSteps,
      SAFETY_LIMIT_CEILINGS.maxSteps,
    );
  }
  if (override.maxDurationMs !== undefined) {
    merged.maxDurationMs = validateLimit(
      'safetyLimits.maxDurationMs',
      override.maxDurationMs,
      SAFETY_LIMIT_CEILINGS.maxDurationMs,
    );
  }
  if (override.budgetCap !== undefined) {
    merged.budgetCap = validateLimit('safetyLimits.budgetCap', override.budgetCap);
  }
  return merged;
}

/**
 * Validate a single safety-limit value: a positive finite number, optionally
 * within a hard ceiling.
 *
 * @param field The override field name, for error reporting.
 * @param value The candidate limit value.
 * @param ceiling An optional inclusive upper bound (Req 15.2, 15.3).
 * @returns The validated value.
 * @throws InvalidTemplateOverrideError if non-positive, non-finite, or over the ceiling.
 */
function validateLimit(field: string, value: number, ceiling?: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidTemplateOverrideError(field, 'must be a positive number');
  }
  if (ceiling !== undefined && value > ceiling) {
    throw new InvalidTemplateOverrideError(field, `must not exceed ${ceiling}`);
  }
  return value;
}

/**
 * Create a concrete agent definition from a template, copying its
 * configuration and applying any overrides (Req 16.5, Property 37).
 *
 * The produced {@link AgentDefinition} copies the template's `systemPrompt`,
 * `allowedTools`, `model`, and `safetyLimits` (deep copies — it shares no
 * array/object reference with the template), names the agent after the template
 * (unless overridden), and records the template's id as the `templateId`
 * provenance link. With no overrides (or an empty object) the copy is verbatim;
 * each present, validated override field replaces the corresponding value.
 *
 * @param template The source template (e.g. from {@link getTemplate}).
 * @param overrides Optional, validated customizations layered on top.
 * @returns A new, independently-mutable agent definition.
 * @throws InvalidTemplateOverrideError if any supplied override is invalid.
 */
export function createFromTemplate(
  template: AgentTemplate,
  overrides: AgentTemplateOverrides = {},
): AgentDefinition {
  const name =
    overrides.name !== undefined ? requireNonBlank('name', overrides.name) : template.name;
  const systemPrompt =
    overrides.systemPrompt !== undefined
      ? requireNonBlank('systemPrompt', overrides.systemPrompt)
      : template.systemPrompt;
  const model =
    overrides.model !== undefined ? requireNonBlank('model', overrides.model) : template.model;
  const allowedTools =
    overrides.allowedTools !== undefined
      ? validateAllowedTools(overrides.allowedTools)
      : [...template.allowedTools];
  const safetyLimits = mergeSafetyLimits(template.safetyLimits, overrides.safetyLimits);

  return {
    name,
    systemPrompt,
    allowedTools,
    model,
    safetyLimits,
    templateId: template.id,
  };
}
