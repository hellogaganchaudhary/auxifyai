/**
 * Agent templates and creation-from-template (Req 16.4, 16.5).
 *
 * The pre-built agent-template catalog the platform offers so a power user can
 * stand up a reliable automation in one step instead of hand-authoring an
 * agent's prompt, tool Allow_List, model, and safety limits. It provides:
 *   - a constant catalog of the seven pre-built templates — Research,
 *     Competitive Intel, Code Review, Content Writer, Lead Research, Report
 *     Generator, and Bug Triage (Req 16.4) — grouped into the research /
 *     engineering / content categories ({@link REQUIRED_AGENT_TEMPLATE_CATEGORIES});
 *   - the {@link listTemplates} / {@link findTemplate} / {@link getTemplate}
 *     discovery API (the last fails closed with an
 *     {@link UnknownAgentTemplateError}); and
 *   - {@link createFromTemplate}, which instantiates a concrete
 *     {@link AgentDefinition} by **copying** the template's system prompt,
 *     allowed tools, model, and safety limits (Req 16.5, Property 37), with
 *     optional, validated {@link AgentTemplateOverrides} layered on top (an
 *     invalid override fails closed with an {@link InvalidTemplateOverrideError}).
 *
 * Surface:
 *   - {@link createFromTemplate} / {@link getTemplate} — creation + throwing
 *     discovery; {@link listTemplates} / {@link findTemplate} /
 *     {@link cloneTemplate} / {@link PREDEFINED_AGENT_TEMPLATES} — the catalog.
 *   - {@link AgentTemplate} / {@link AgentDefinition} / {@link AgentTemplateOverrides} /
 *     {@link SafetyLimits} / {@link AgentTemplateCategory} /
 *     {@link REQUIRED_AGENT_TEMPLATE_CATEGORIES} / {@link SAFETY_LIMIT_CEILINGS} —
 *     the domain types (defined here, matching the design's `Agent`/`SafetyLimits`
 *     structurally, so this module never depends on the concurrently-built
 *     Agent_Runtime's in-flight types).
 *   - {@link UnknownAgentTemplateError} / {@link InvalidTemplateOverrideError} —
 *     the typed errors, each projecting to a
 *     {@link import('@auxify/types').PlatformError} (Req 46.8).
 */

export { createFromTemplate, getTemplate } from './create.js';

export {
  PREDEFINED_AGENT_TEMPLATES,
  listTemplates,
  findTemplate,
  cloneTemplate,
} from './catalog.js';

export {
  UnknownAgentTemplateError,
  InvalidTemplateOverrideError,
  UNKNOWN_AGENT_TEMPLATE_CODE,
  INVALID_TEMPLATE_OVERRIDE_CODE,
} from './errors.js';

export {
  SAFETY_LIMIT_CEILINGS,
  REQUIRED_AGENT_TEMPLATE_CATEGORIES,
  type AgentTemplate,
  type AgentDefinition,
  type AgentTemplateOverrides,
  type AgentTemplateCategory,
  type SafetyLimits,
} from './types.js';
