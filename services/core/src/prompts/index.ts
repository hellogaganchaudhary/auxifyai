/**
 * Prompt_Library (Req 10): a library of shared and personal prompt templates.
 *
 * The service handles the prompt-template lifecycle within an Organization:
 * create with title/content/category/tags/ownership (Req 10.1), public/personal
 * visibility with org-wide vs owner-only scoping (Req 10.2, 10.3 / Property 26),
 * `{{ variable }}` filling that is complete before use (Req 10.4 / Property 24),
 * versioned edits that increment the version and retain all prior versions
 * (Req 10.5 / Property 25), usage counting (Req 10.6), and the most-used /
 * highest-rated / most-shared analytics report (Req 10.7). It composes the
 * tenant-scoped prompt repositories and records every mutation through the
 * {@link import('../audit/index.js').AuditRecorder} port.
 *
 * Surface:
 *   - {@link PromptLibrary} — the service; one method per acceptance criterion
 *     (create / setVisibility / listVisibleTo / getForUser / fillVariables /
 *     edit / listVersions / recordUse / analytics).
 *   - {@link PromptTemplateRepository} / {@link PromptVersionRepository} — the
 *     tenant-scoped persistence over `prompt_templates` / `prompt_versions`.
 *   - {@link findMissingVariables} — surfaces unresolved `{{var}}` names; the
 *     substitution itself reuses the same `{{var}}` syntax as the
 *     Persona_Manager (Req 9.5 / Property 24) via an internal `./variables`
 *     module (not re-exported here to avoid shadowing the persona helper).
 *   - {@link computePromptAnalytics} — the pure ranking core (Req 10.7).
 *   - Domain types ({@link PromptTemplate}, {@link PromptVersion},
 *     {@link PromptAnalytics}, …) and the typed errors
 *     ({@link PromptTemplateNotFoundError}, {@link MissingPromptVariablesError}).
 *   - In-memory fakes for unit/property tests.
 */

export {
  PromptLibrary,
  type PromptLibraryOptions,
  type PromptIdGenerator,
} from './prompt-library.js';

export { PromptTemplateRepository, PromptVersionRepository } from './prompt-repository.js';

export { computePromptAnalytics } from './analytics.js';

// NOTE: the `{{var}}` substitution helpers (substituteVariables /
// extractVariableNames / VARIABLE_NAME_PATTERN) are intentionally NOT
// re-exported from this barrel: the Persona_Manager (Req 9.5) already exports a
// `substituteVariables` of the same `{{var}}` syntax package-wide, and exporting
// a second generic copy here would shadow it. The Prompt_Library consumes its
// own internal `./variables.js` (identical syntax, so Property 24 covers both);
// only the prompt-specific `findMissingVariables` is surfaced.
export { findMissingVariables } from './variables.js';

export {
  PromptTemplateNotFoundError,
  MissingPromptVariablesError,
  PROMPT_TEMPLATE_NOT_FOUND_CODE,
  MISSING_PROMPT_VARIABLES_CODE,
} from './errors.js';

export {
  PROMPT_VISIBILITIES,
  DEFAULT_ANALYTICS_LIMIT,
  type PromptVisibility,
  type PromptTemplate,
  type PromptVersion,
  type PromptTemplateInput,
  type OrgScope,
  type PromptAnalytics,
  type PromptAnalyticsEntry,
  type PromptTemplateStore,
  type PromptVersionStore,
  type CreatePromptTemplateRow,
  type UpdatePromptTemplateRow,
  type AppendPromptVersionRow,
} from './types.js';

// NOTE: the in-memory test fakes (InMemoryPromptTemplateStore,
// InMemoryPromptVersionStore, CapturingAuditRecorder, makePromptTemplate,
// sequentialPromptIdGenerator) are intentionally NOT re-exported from the
// package barrel — they would collide with the equally-named audit-recorder
// fakes of sibling modules (conversations/artifacts). Following the established
// convention, consumers and the companion property tests (tasks 9.4, 9.6)
// import them directly from `./prompts/fakes.js`.
