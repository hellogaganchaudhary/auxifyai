/**
 * The pre-built agent-template catalog (Req 16.4).
 *
 * The platform ships seven ready-to-use agent templates — Research,
 * Competitive Intel, Code Review, Content Writer, Lead Research, Report
 * Generator, and Bug Triage (Req 16.4) — as a constant catalog rather than
 * seeded rows, so they are always available without a database migration or
 * seed step. They are grouped into the {@link AgentTemplateCategory} buckets and
 * cover every {@link REQUIRED_AGENT_TEMPLATE_CATEGORIES} category.
 *
 * Each template carries the four pieces of configuration
 * {@link import('./create.js').createFromTemplate} copies into a new agent
 * (Req 16.5): a `systemPrompt`, a default tool-id `allowedTools` Allow_List
 * (drawn from the Tool_Registry's stable tool ids — `web_search`, `sql_query`,
 * `run_code`, `send_message`, `create_page`, `github_issue` — gated at run time
 * by the agent's Allow_List, Req 16.3), a default `model`, and default
 * {@link SafetyLimits} that always stay within the platform ceilings
 * ({@link SAFETY_LIMIT_CEILINGS}, Req 15.2, 15.3).
 *
 * Templates use stable `agent-template-*` ids so a created agent's `templateId`
 * provenance link (Req 16.5) and any UI references remain stable across
 * deployments. Accessors return fresh clones so callers can never mutate the
 * shared catalog constants.
 */

import type { AgentTemplate } from './types.js';

/** A conservative default budget cap (USD) for a single agent run. */
const DEFAULT_BUDGET_CAP = 5 as const;

/**
 * The seven pre-built agent templates (Req 16.4).
 *
 * Grouped by category for readability; correctness only depends on each
 * required category being represented (asserted by the catalog tests).
 */
export const PREDEFINED_AGENT_TEMPLATES: readonly AgentTemplate[] = [
  // --- research ----------------------------------------------------------
  {
    id: 'agent-template-research',
    name: 'Research Agent',
    category: 'research',
    description:
      'Investigates an open-ended question across the web, synthesizes findings, ' +
      'and writes up a sourced summary.',
    systemPrompt:
      'You are a thorough research agent. Break the question into sub-questions, ' +
      'search the web for authoritative sources, cross-check claims across multiple ' +
      'sources, and synthesize a concise, well-cited answer. Always attribute facts to ' +
      'their source and flag uncertainty explicitly.',
    allowedTools: ['web_search', 'create_page'],
    model: 'gpt-4o',
    safetyLimits: { maxSteps: 30, maxDurationMs: 8 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  {
    id: 'agent-template-competitive-intel',
    name: 'Competitive Intel Agent',
    category: 'research',
    description:
      'Tracks competitors by gathering public signals and producing a structured ' +
      'competitive landscape brief.',
    systemPrompt:
      'You are a competitive intelligence analyst. Identify the named competitors, ' +
      'search for recent public signals (product launches, pricing, hiring, funding), ' +
      'and organize findings into a structured brief comparing positioning, strengths, ' +
      'and weaknesses. Cite every claim and never speculate beyond the evidence.',
    allowedTools: ['web_search', 'create_page'],
    model: 'gpt-4o',
    safetyLimits: { maxSteps: 35, maxDurationMs: 9 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  {
    id: 'agent-template-lead-research',
    name: 'Lead Research Agent',
    category: 'research',
    description:
      'Enriches a sales lead by gathering firmographic and contact context and ' +
      'drafting a tailored outreach summary.',
    systemPrompt:
      'You are a sales lead research assistant. Given a company or contact, gather ' +
      'public firmographic details, recent news, and likely pain points, then produce a ' +
      'concise enrichment summary with a suggested, personalized outreach angle. Use only ' +
      'public information and cite your sources.',
    allowedTools: ['web_search', 'send_message'],
    model: 'gpt-4o-mini',
    safetyLimits: { maxSteps: 25, maxDurationMs: 6 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  // --- engineering -------------------------------------------------------
  {
    id: 'agent-template-code-review',
    name: 'Code Review Agent',
    category: 'engineering',
    description:
      'Reviews a code change for correctness, security, and maintainability and ' +
      'leaves specific, actionable feedback.',
    systemPrompt:
      'You are a meticulous code reviewer. Analyze the change for bugs, security ' +
      'issues, and maintainability problems. Run the code in the sandbox when it helps ' +
      'verify behavior. Be specific and constructive: cite the relevant lines and suggest ' +
      'concrete fixes rather than vague advice.',
    allowedTools: ['run_code', 'github_issue'],
    model: 'claude-sonnet-4',
    safetyLimits: { maxSteps: 40, maxDurationMs: 9 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  {
    id: 'agent-template-bug-triage',
    name: 'Bug Triage Agent',
    category: 'engineering',
    description:
      'Triages an incoming bug report: reproduces, classifies severity, and files a ' +
      'structured issue with a likely root cause.',
    systemPrompt:
      'You are a bug triage engineer. Reproduce the reported problem in the sandbox ' +
      'when possible, classify its severity and likely root cause, search for related ' +
      'prior reports, and file a clear, structured issue with reproduction steps and a ' +
      'recommended next action. Never invent reproduction details you have not verified.',
    allowedTools: ['run_code', 'web_search', 'github_issue'],
    model: 'claude-sonnet-4',
    safetyLimits: { maxSteps: 40, maxDurationMs: 10 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  // --- content -----------------------------------------------------------
  {
    id: 'agent-template-content-writer',
    name: 'Content Writer Agent',
    category: 'content',
    description:
      'Drafts on-brand long-form content from a brief, researching supporting facts ' +
      'and publishing a draft page.',
    systemPrompt:
      'You are a skilled content writer. From the brief, research supporting facts, ' +
      'then draft clear, engaging, on-brand copy with a strong hook and short paragraphs. ' +
      'Align tone with the target audience, avoid hype and unsupported claims, and cite ' +
      'any factual sources you rely on.',
    allowedTools: ['web_search', 'create_page'],
    model: 'gpt-4o',
    safetyLimits: { maxSteps: 30, maxDurationMs: 8 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
  {
    id: 'agent-template-report-generator',
    name: 'Report Generator Agent',
    category: 'content',
    description:
      'Compiles data from internal sources into a structured, shareable report and ' +
      'delivers it to the requested channel.',
    systemPrompt:
      'You are a report generation assistant. Query the requested data, compute the ' +
      'summary metrics, and compile a clear, structured report with sections, tables, and ' +
      'a short executive summary. Deliver the finished report to the requested destination ' +
      'and state the data range and any caveats explicitly.',
    allowedTools: ['sql_query', 'create_page', 'send_message'],
    model: 'gpt-4o',
    safetyLimits: { maxSteps: 35, maxDurationMs: 9 * 60 * 1000, budgetCap: DEFAULT_BUDGET_CAP },
  },
] as const;

/**
 * A deep-enough clone of a template so the shared catalog constants stay
 * immutable no matter what a caller does with the returned value.
 *
 * @param template The template to clone.
 * @returns A fresh, independently-mutable copy.
 */
export function cloneTemplate(template: AgentTemplate): AgentTemplate {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    description: template.description,
    systemPrompt: template.systemPrompt,
    allowedTools: [...template.allowedTools],
    model: template.model,
    safetyLimits: { ...template.safetyLimits },
  };
}

/**
 * Every pre-built agent template (Req 16.4), as fresh clones.
 *
 * @returns A new array of independently-mutable template clones.
 */
export function listTemplates(): AgentTemplate[] {
  return PREDEFINED_AGENT_TEMPLATES.map(cloneTemplate);
}

/**
 * Look up a pre-built agent template by id (Req 16.4).
 *
 * @param templateId The template id to resolve.
 * @returns A fresh clone of the matching template, or `undefined` if none match.
 */
export function findTemplate(templateId: string): AgentTemplate | undefined {
  const found = PREDEFINED_AGENT_TEMPLATES.find((t) => t.id === templateId);
  return found === undefined ? undefined : cloneTemplate(found);
}
