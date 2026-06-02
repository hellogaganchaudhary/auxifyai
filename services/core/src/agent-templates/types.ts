/**
 * Agent template domain types (Req 16.4, 16.5).
 *
 * The platform ships a catalog of pre-built **agent templates** so a power user
 * can stand up a reliable automation in one step rather than hand-authoring an
 * agent's prompt, tool Allow_List, model, and safety limits (Req 16.4). Creating
 * an agent from a template copies the template's system prompt, allowed tools,
 * model, and safety limits into the new agent (Req 16.5); a caller may layer
 * {@link AgentTemplateOverrides} on top to customize the result.
 *
 * These types are defined here, in the agent-templates module, rather than
 * imported from the concurrently-built Agent_Runtime (task 15.5, `../agent/`),
 * so this module never depends on that module's in-flight types. Two shapes are
 * nonetheless defined to match the design document's `Agent`/`SafetyLimits`
 * exactly so they align *structurally* with whatever the Agent_Runtime persists:
 *   - {@link SafetyLimits} mirrors the design's `SafetyLimits`
 *     (`maxSteps`/`maxDurationMs`/`budgetCap`, Req 15.2-15.4); and
 *   - {@link AgentDefinition} is the configuration subset of the design's
 *     `Agent` — the `name`/`systemPrompt`/`allowedTools`/`model`/`safetyLimits`/
 *     `templateId` fields a template populates (the persistence/tenant fields
 *     `id`/`organizationId`/`projectId` are assigned by the caller when the
 *     definition is persisted as an Agent).
 *
 * The module has no runtime coupling beyond `@auxify/types`.
 */

/**
 * The safety limits enforced on an agent run (Req 15.2, 15.3, 15.4).
 *
 * Mirrors the design's `SafetyLimits` exactly so a definition produced here
 * aligns structurally with the Agent_Runtime's persisted `Agent`:
 *   - `maxSteps` — the run stops and reports at this step count (Req 15.2);
 *   - `maxDurationMs` — the run stops and reports at this wall-clock duration
 *     (Req 15.3); and
 *   - `budgetCap` — the run stops and reports at this spend (Req 15.4).
 *
 * A template's limits never exceed the platform's hard ceilings of 50 steps and
 * 10 minutes (600000 ms); see {@link SAFETY_LIMIT_CEILINGS}.
 */
export interface SafetyLimits {
  /** Maximum number of steps before the run is stopped at the step limit (Req 15.2). */
  maxSteps: number;
  /** Maximum wall-clock duration (ms) before the run is stopped at the time limit (Req 15.3). */
  maxDurationMs: number;
  /** Maximum spend before the run is stopped at the budget cap (Req 15.4). */
  budgetCap: number;
}

/**
 * The platform's hard safety-limit ceilings (Req 15.2, 15.3).
 *
 * The Agent_Runtime stops a run at 50 steps (Req 15.2) and at 10 minutes
 * (Req 15.3); a template's {@link SafetyLimits} must stay within these so a
 * template can never request a run that outlives the platform's guarantees.
 */
export const SAFETY_LIMIT_CEILINGS = {
  /** Hard maximum step count (Req 15.2). */
  maxSteps: 50,
  /** Hard maximum duration in milliseconds — 10 minutes (Req 15.3). */
  maxDurationMs: 10 * 60 * 1000,
} as const;

/**
 * The categories the pre-built agent-template catalog groups its templates into.
 *
 *   - `research` — open-ended web/data investigation and synthesis (Research,
 *     Competitive Intel, Lead Research).
 *   - `engineering` — code- and defect-oriented agents (Code Review, Bug Triage).
 *   - `content` — drafting and reporting agents (Content Writer, Report Generator).
 *
 * The union is the single source of truth so the catalog and discovery filters
 * never redefine it locally.
 */
export type AgentTemplateCategory = 'research' | 'engineering' | 'content';

/**
 * Every {@link AgentTemplateCategory} the catalog must cover, in display order.
 *
 * The pre-built catalog (Req 16.4) is guaranteed to contain at least one
 * template in each of these categories.
 */
export const REQUIRED_AGENT_TEMPLATE_CATEGORIES: readonly AgentTemplateCategory[] = [
  'research',
  'engineering',
  'content',
] as const;

/**
 * A pre-built agent template (Req 16.4).
 *
 * A template is a named, categorized, ready-to-use agent configuration: a
 * stable id and display `name`, the {@link AgentTemplateCategory} it belongs to,
 * a human-readable `description`, and the four pieces of configuration
 * {@link createFromTemplate} copies into a new agent (Req 16.5) — `systemPrompt`,
 * the default `allowedTools` Allow_List (tool ids gated by the Tool_Registry,
 * Req 16.3), the default `model`, and the default {@link SafetyLimits}.
 */
export interface AgentTemplate {
  /** Stable, unique template id (e.g. `agent-template-research`). */
  id: string;
  /** Human-readable display name (e.g. `Research Agent`). */
  name: string;
  /** The category this template belongs to. */
  category: AgentTemplateCategory;
  /** Human-readable description of what the template's agent does. */
  description: string;
  /** The default system prompt copied into a created agent (Req 16.5). */
  systemPrompt: string;
  /** The default tool-id Allow_List copied into a created agent (Req 16.3, 16.5). */
  allowedTools: string[];
  /** The default model id copied into a created agent (Req 16.5). */
  model: string;
  /** The default safety limits copied into a created agent (Req 15.2-15.4, 16.5). */
  safetyLimits: SafetyLimits;
}

/**
 * A concrete agent definition produced from a template (Req 16.5).
 *
 * This is the configuration subset of the design's `Agent`: the fields a
 * template populates (`name`, `systemPrompt`, `allowedTools`, `model`,
 * `safetyLimits`) plus the `templateId` provenance link back to the source
 * template. The persistence/tenant fields (`id`, `organizationId`, `projectId`)
 * are assigned by the caller when the definition is persisted as an Agent, so
 * they are intentionally absent here.
 */
export interface AgentDefinition {
  /** The agent's display name (the template name unless overridden). */
  name: string;
  /** The system prompt copied from the template (Req 16.5). */
  systemPrompt: string;
  /** The tool-id Allow_List copied from the template (Req 16.3, 16.5). */
  allowedTools: string[];
  /** The model id copied from the template (Req 16.5). */
  model: string;
  /** The safety limits copied from the template (Req 15.2-15.4, 16.5). */
  safetyLimits: SafetyLimits;
  /** The id of the template this agent was created from (provenance, Req 16.5). */
  templateId: string;
}

/**
 * Optional caller overrides applied on top of a template by
 * {@link createFromTemplate} (Req 16.5).
 *
 * Every field is optional: an absent field leaves the template's value intact,
 * so an empty (or omitted) overrides object copies the template verbatim
 * (Property 37). A present field replaces the corresponding template value after
 * validation. `safetyLimits` is a *partial* override — only the limits supplied
 * are replaced, the rest are inherited from the template.
 */
export interface AgentTemplateOverrides {
  /** Replace the agent name (must be non-blank when present). */
  name?: string;
  /** Replace the system prompt (must be non-blank when present). */
  systemPrompt?: string;
  /** Replace the tool-id Allow_List (each id non-blank; duplicates rejected). */
  allowedTools?: string[];
  /** Replace the model id (must be non-blank when present). */
  model?: string;
  /** Partially replace the safety limits (each supplied limit must be valid). */
  safetyLimits?: Partial<SafetyLimits>;
}
