/**
 * The Auxify Document Engine — the Gamma-like generation orchestrator.
 *
 * Given a natural-language prompt ("Create a 15-page grant proposal for
 * Auxify"), it runs the full design workflow and streams progress as SSE:
 *
 *   prompt
 *     → intent detection + template selection   (deterministic + light LLM)
 *     → design plan   (theme, title, section briefs)
 *     → content authoring   (a strict-JSON {@link DocumentSpec})
 *     → validation + sanitization
 *     → rendering   (PPTX / PDF / DOCX via the design-aware renderers)
 *     → completion   (base64 file + the spec, for preview/editing)
 *
 * The model never produces binary or layout code — it produces a structured,
 * validated {@link DocumentSpec}; the renderers own all visual design. This
 * keeps output consistent, on-brand, and safe.
 */

import type { ChatChunk, ChatRequest } from '@auxify/types';

import {
  getTemplate,
  normalizeHex,
  selectTemplate,
  THEME_IDS,
  type DocumentSection,
  type DocumentSpec,
  type SectionLayout,
  type ThemeId,
} from './document-design';
import { renderDesignedDocument, type DesignedFormat } from './file-generate';

/** One SSE frame emitted by the document orchestrator. */
export interface DocumentEvent {
  /** Event name: `step`, `spec`, `completion`, `error`. */
  event: string;
  /** JSON-encoded payload. */
  data: string;
}

/** Input to a document-generation run. */
export interface DocumentGenInput {
  /** The user's natural-language request. */
  prompt: string;
  /** The model id used for planning + authoring. */
  modelId: string;
  /** Output format (defaults to the selected template's preferred format). */
  format?: DesignedFormat;
  /** Force a theme; otherwise the AI / template chooses. */
  themeId?: ThemeId;
  /** Force a template id; otherwise it is auto-selected from the prompt. */
  templateId?: string;
  /** Branding overrides (organization, colors, footer, watermark). */
  brand?: {
    organization?: string;
    primaryColor?: string;
    accentColor?: string;
    footer?: string;
    watermark?: string;
  };
  /** Max OUTPUT tokens for the authoring call (controls document length). */
  maxTokens?: number;
}

/** The collaborators the orchestrator needs. */
export interface DocumentGenDeps {
  /** Stream a chat completion (the composition resolves the provider). */
  runChat: (req: ChatRequest) => AsyncIterable<ChatChunk>;
}

/** Encode an object as an SSE frame. */
function ev(event: string, data: unknown): DocumentEvent {
  return { event, data: JSON.stringify(data) };
}

/** Accumulated token usage across all LLM calls in a run. */
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
}

/** Collect a full (non-streamed) completion. */
async function complete(
  runChat: DocumentGenDeps['runChat'],
  req: ChatRequest,
  usage: UsageAccumulator,
): Promise<string> {
  let out = '';
  for await (const chunk of runChat(req)) {
    if (chunk.delta.length > 0) out += chunk.delta;
    if (chunk.usage !== undefined) {
      usage.inputTokens += chunk.usage.inputTokens;
      usage.outputTokens += chunk.usage.outputTokens;
    }
  }
  return out.trim();
}

/** Pull the first JSON object out of a model response (handles ```json fences). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    // Best-effort repair: strip trailing commas before } or ].
    try {
      return JSON.parse(candidate.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return undefined;
    }
  }
}

/** The valid section layouts (for validation). */
const VALID_LAYOUTS: readonly SectionLayout[] = [
  'cover',
  'section-divider',
  'bullets',
  'paragraph',
  'two-column',
  'comparison',
  'table',
  'chart',
  'kpis',
  'timeline',
  'quote',
  'callout',
  'closing',
] as const;

/** A short, deterministic today string (e.g. "June 2026"). */
function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

/** Clamp a string to a max length, trimming whitespace. */
function clampStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

/** Coerce an unknown value to a clean string array. */
function strArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => clampStr(v, maxLen))
    .filter((v): v is string => v !== undefined)
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

/** Coerce an unknown value to a finite number, or undefined. */
function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.replace(/[, %$]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Validate and sanitize one raw section object from the model into a safe
 * {@link DocumentSection}. Unknown layouts fall back to `bullets`/`paragraph`.
 */
function sanitizeSection(raw: unknown): DocumentSection | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  let layout = (typeof r.layout === 'string' ? r.layout : '') as SectionLayout;
  if (!VALID_LAYOUTS.includes(layout)) layout = 'bullets';

  const section: DocumentSection = { layout };
  const title = clampStr(r.title, 160);
  const subtitle = clampStr(r.subtitle, 220);
  const body = clampStr(r.body, 2400);
  const bullets = strArray(r.bullets, 10, 320);
  if (title !== undefined) section.title = title;
  if (subtitle !== undefined) section.subtitle = subtitle;
  if (body !== undefined) section.body = body;
  if (bullets !== undefined) section.bullets = bullets;
  if (typeof r.notes === 'string') {
    const notes = clampStr(r.notes, 1200);
    if (notes !== undefined) section.notes = notes;
  }

  // Columns (two-column / comparison).
  if (Array.isArray(r.columns)) {
    const columns = r.columns
      .slice(0, 3)
      .map((c) => {
        if (c === null || typeof c !== 'object') return undefined;
        const cc = c as Record<string, unknown>;
        const heading = clampStr(cc.heading, 120);
        const colBullets = strArray(cc.bullets, 8, 240);
        const colBody = clampStr(cc.body, 800);
        if (heading === undefined && colBullets === undefined && colBody === undefined) return undefined;
        return {
          ...(heading !== undefined ? { heading } : {}),
          ...(colBullets !== undefined ? { bullets: colBullets } : {}),
          ...(colBody !== undefined ? { body: colBody } : {}),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (columns.length > 0) section.columns = columns;
  }

  // Table.
  if (r.table !== null && typeof r.table === 'object') {
    const t = r.table as Record<string, unknown>;
    const header = strArray(t.header, 8, 60);
    const rowsRaw = Array.isArray(t.rows) ? t.rows : [];
    const rows = rowsRaw
      .slice(0, 30)
      .map((row) => strArray(row, 8, 120) ?? [])
      .filter((row) => row.length > 0);
    if (header !== undefined && rows.length > 0) section.table = { header, rows };
  }

  // Chart.
  if (r.chart !== null && typeof r.chart === 'object') {
    const c = r.chart as Record<string, unknown>;
    const type = c.type === 'line' || c.type === 'pie' || c.type === 'doughnut' ? c.type : 'bar';
    const categories = strArray(c.categories, 12, 40);
    const seriesRaw = Array.isArray(c.series) ? c.series : [];
    const series = seriesRaw
      .slice(0, 5)
      .map((s) => {
        if (s === null || typeof s !== 'object') return undefined;
        const ss = s as Record<string, unknown>;
        const name = clampStr(ss.name, 40) ?? 'Series';
        const values = Array.isArray(ss.values)
          ? ss.values.map(num).filter((v): v is number => v !== undefined)
          : [];
        return values.length > 0 ? { name, values } : undefined;
      })
      .filter((s): s is { name: string; values: number[] } => s !== undefined);
    if (categories !== undefined && series.length > 0) {
      section.chart = { type, categories, series, ...(clampStr(c.title, 120) !== undefined ? { title: clampStr(c.title, 120)! } : {}) };
    }
  }

  // KPIs.
  if (Array.isArray(r.kpis)) {
    const kpis = r.kpis
      .slice(0, 6)
      .map((k) => {
        if (k === null || typeof k !== 'object') return undefined;
        const kk = k as Record<string, unknown>;
        const label = clampStr(kk.label, 48);
        const value = clampStr(kk.value, 32);
        if (label === undefined || value === undefined) return undefined;
        const sub = clampStr(kk.sub, 48);
        return { label, value, ...(sub !== undefined ? { sub } : {}) };
      })
      .filter((k): k is { label: string; value: string; sub?: string } => k !== undefined);
    if (kpis.length > 0) section.kpis = kpis;
  }

  // Timeline.
  if (Array.isArray(r.timeline)) {
    const timeline = r.timeline
      .slice(0, 8)
      .map((t) => {
        if (t === null || typeof t !== 'object') return undefined;
        const tt = t as Record<string, unknown>;
        const date = clampStr(tt.date, 40);
        const tTitle = clampStr(tt.title, 120);
        if (date === undefined || tTitle === undefined) return undefined;
        const detail = clampStr(tt.detail, 200);
        return { date, title: tTitle, ...(detail !== undefined ? { detail } : {}) };
      })
      .filter((t): t is { date: string; title: string; detail?: string } => t !== undefined);
    if (timeline.length > 0) section.timeline = timeline;
  }

  // Quote.
  if (r.quote !== null && typeof r.quote === 'object') {
    const q = r.quote as Record<string, unknown>;
    const qText = clampStr(q.text, 400);
    if (qText !== undefined) {
      const attribution = clampStr(q.attribution, 80);
      section.quote = { text: qText, ...(attribution !== undefined ? { attribution } : {}) };
    }
  }

  // Callout.
  if (r.callout !== null && typeof r.callout === 'object') {
    const co = r.callout as Record<string, unknown>;
    const coText = clampStr(co.text, 400);
    if (coText !== undefined) {
      const variant =
        co.variant === 'success' || co.variant === 'warning' || co.variant === 'highlight'
          ? co.variant
          : 'info';
      const coTitle = clampStr(co.title, 80);
      section.callout = { variant, text: coText, ...(coTitle !== undefined ? { title: coTitle } : {}) };
    }
  }

  return section;
}

/** Validate the raw model JSON into a safe, render-ready {@link DocumentSpec}. */
function sanitizeSpec(
  raw: unknown,
  fallback: { docType: string; themeId: ThemeId; title: string },
  brand: DocumentGenInput['brand'],
): DocumentSpec {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const themeId = (typeof r.themeId === 'string' && THEME_IDS.includes(r.themeId as ThemeId)
    ? r.themeId
    : fallback.themeId) as ThemeId;

  const sectionsRaw = Array.isArray(r.sections) ? r.sections : [];
  const sections = sectionsRaw
    .map(sanitizeSection)
    .filter((s): s is DocumentSection => s !== undefined)
    .slice(0, 40);

  // Guarantee a cover + at least one body section.
  if (!sections.some((s) => s.layout === 'cover')) {
    sections.unshift({ layout: 'cover', title: fallback.title });
  }
  if (sections.length < 2) {
    sections.push({ layout: 'paragraph', title: 'Overview', body: 'No content was generated.' });
  }

  const spec: DocumentSpec = {
    docType: clampStr(r.docType, 60) ?? fallback.docType,
    themeId,
    title: clampStr(r.title, 160) ?? fallback.title,
    date: todayLabel(),
    sections,
  };
  const subtitle = clampStr(r.subtitle, 220);
  const author = clampStr(r.author, 120) ?? brand?.organization;
  if (subtitle !== undefined) spec.subtitle = subtitle;
  if (author !== undefined) spec.author = author;

  // Merge branding (input overrides the model).
  const org = brand?.organization ?? clampStr((r.brand as Record<string, unknown> | undefined)?.organization, 120);
  const primaryColor = normalizeHex(brand?.primaryColor);
  const accentColor = normalizeHex(brand?.accentColor);
  const footer = clampStr(brand?.footer, 160);
  const watermark = clampStr(brand?.watermark, 60);
  if (org !== undefined || primaryColor !== undefined || accentColor !== undefined || footer !== undefined || watermark !== undefined) {
    spec.brand = {
      ...(org !== undefined ? { organization: org } : {}),
      ...(primaryColor !== undefined ? { primaryColor } : {}),
      ...(accentColor !== undefined ? { accentColor } : {}),
      ...(footer !== undefined ? { footer } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
    };
  }

  return spec;
}

/** The strict JSON schema description injected into the authoring prompt. */
const SPEC_SCHEMA_DOC = `Return ONLY a JSON object (no prose, no code fence) with this exact shape:
{
  "docType": string,            // e.g. "pitch-deck", "grant-proposal"
  "themeId": string,            // one of: ${THEME_IDS.join(', ')}
  "title": string,              // cover title (max ~10 words)
  "subtitle": string,           // cover subtitle / tagline
  "author": string,             // presenter or organization (optional)
  "sections": [                 // 6–18 sections, each a slide/page
    {
      "layout": string,         // one of: cover, section-divider, bullets, paragraph, two-column, comparison, table, chart, kpis, timeline, quote, callout, closing
      "title": string,
      "subtitle": string,       // optional kicker
      "body": string,           // prose for paragraph layouts
      "bullets": [string],      // 3–6 concise points for bullets layouts
      "columns": [ { "heading": string, "bullets": [string] } ],  // for two-column/comparison
      "table": { "header": [string], "rows": [[string]] },         // for table
      "chart": { "type": "bar|line|pie|doughnut", "title": string, "categories": [string], "series": [ { "name": string, "values": [number] } ] },
      "kpis": [ { "label": string, "value": string, "sub": string } ],   // 3–4 metric tiles
      "timeline": [ { "date": string, "title": string, "detail": string } ],
      "quote": { "text": string, "attribution": string },
      "callout": { "variant": "info|success|warning|highlight", "title": string, "text": string },
      "notes": string           // optional speaker notes
    }
  ]
}

RULES:
- The FIRST section MUST be layout "cover" with the title + subtitle.
- The LAST section SHOULD be layout "closing" (decks) or "paragraph" (documents).
- Choose the layout that best fits each section's content. Use charts/kpis/tables/timelines where they add value — invent realistic, plausible numbers when the user has none.
- Keep bullets short (max ~12 words). Keep prose tight and professional.
- Every chart MUST have matching category/value counts. Every table row MUST match the header length.
- Output MUST be valid JSON. Do not wrap it in markdown.`;

/**
 * Run a full document-generation session, yielding SSE frames for each phase
 * and a final `completion` carrying the rendered file (base64) and the spec.
 */
export async function* runDocumentGeneration(
  input: DocumentGenInput,
  deps: DocumentGenDeps,
): AsyncIterable<DocumentEvent> {
  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0 };

  // ── Phase 1: intent detection + template selection (deterministic) ─────────
  const template = getTemplate(input.templateId) ?? selectTemplate(input.prompt);
  const format: DesignedFormat = input.format ?? template.preferredFormat;
  const themeId: ThemeId = input.themeId ?? template.defaultTheme;
  const tokenBudget = Math.max(input.maxTokens ?? 16_000, 4_000);

  yield ev('step', {
    phase: 'planning',
    message: `Designing a ${template.name.toLowerCase()} (${format.toUpperCase()}, ${themeId} theme)…`,
    docType: template.id,
    format,
    themeId,
  });

  // ── Phase 2 + 3: author the structured spec in one strict-JSON call ────────
  yield ev('step', { phase: 'authoring', message: 'Writing content and laying out sections…' });

  const outlineHint = template.outline.join(' → ');
  const system: ChatRequest['messages'][number] = {
    role: 'system',
    content:
      `You are Auxify's principal document designer — equal parts McKinsey partner, brand designer and ` +
      `data storyteller. You produce board-ready, Gamma-quality documents as STRUCTURED JSON only.\n\n` +
      `Template: ${template.name}. ${template.guidance}\n` +
      `Suggested section flow: ${outlineHint}. Adapt freely to the user's request.\n` +
      `Preferred theme: ${themeId}.\n\n` +
      SPEC_SCHEMA_DOC,
  };
  const user: ChatRequest['messages'][number] = {
    role: 'user',
    content: `Create this document as a complete JSON spec:\n\n${input.prompt}`,
  };

  let specText = '';
  try {
    specText = await complete(
      deps.runChat,
      { modelId: input.modelId, messages: [system, user], maxTokens: tokenBudget, temperature: 0.6 },
      usage,
    );
  } catch (error) {
    yield ev('error', {
      message: error instanceof Error ? error.message : 'authoring failed',
      usage,
    });
    return;
  }

  const parsed = extractJson(specText);
  if (parsed === undefined) {
    yield ev('error', { message: 'The model did not return a valid document spec. Try again.', usage });
    return;
  }

  // ── Phase 4: validate + sanitize ───────────────────────────────────────────
  const spec = sanitizeSpec(
    parsed,
    { docType: template.id, themeId, title: input.prompt.slice(0, 80) },
    input.brand,
  );
  yield ev('spec', { spec, sectionCount: spec.sections.length });

  // ── Phase 5: render ────────────────────────────────────────────────────────
  yield ev('step', {
    phase: 'rendering',
    message: `Rendering ${spec.sections.length} ${format === 'pptx' ? 'slides' : 'pages'}…`,
    sectionCount: spec.sections.length,
  });

  let file;
  try {
    file = await renderDesignedDocument(spec, format);
  } catch (error) {
    yield ev('error', {
      message: error instanceof Error ? error.message : 'rendering failed',
      usage,
    });
    return;
  }

  // Also render a PDF preview for non-PDF formats so the client can show the
  // designed result inline (browsers render PDFs natively; PPTX/DOCX not).
  let preview: typeof file | undefined;
  if (format !== 'pdf') {
    try {
      preview = await renderDesignedDocument(spec, 'pdf');
    } catch {
      // Preview is best-effort — the primary file already rendered fine.
    }
  }

  // ── Phase 6: completion ────────────────────────────────────────────────────
  yield ev('completion', {
    file,
    ...(preview !== undefined ? { preview } : {}),
    spec,
    docType: spec.docType,
    themeId: spec.themeId,
    format,
    usage,
  });
}

// Re-export so the design metadata is reachable through the engine module too.
export { THEMES, THEME_IDS, TEMPLATES, resolveTheme, applyBrand } from './document-design';
