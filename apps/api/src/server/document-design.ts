/**
 * The Auxify Design Engine — the "Gamma-like" visual system.
 *
 * This module is the design contract shared by the AI orchestrator
 * ({@link ./document-engine}) and the binary renderers
 * ({@link ./file-generate}). It defines:
 *
 *   1. A {@link Theme} system — professional color palettes, typography, and
 *      layout tokens for seven business styles (Modern SaaS, Enterprise,
 *      Startup, Consulting, Government, Investor Pitch, Corporate).
 *   2. A structured {@link DocumentSpec} — the JSON the AI produces describing
 *      a fully designed document: cover, sections, charts, KPIs, tables,
 *      timelines, callouts, quotes and branding.
 *   3. A {@link DocumentTemplate} registry — reusable document blueprints
 *      (grant proposal, pitch deck, research report, …) the AI selects from.
 *
 * Colors are stored as 6-digit hex WITHOUT a leading `#` (the form pptxgenjs
 * expects); the PDF renderer adds the `#` itself.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 *  Theme system
 * ────────────────────────────────────────────────────────────────────────── */

/** The built-in theme identifiers. */
export type ThemeId =
  | 'modern-saas'
  | 'enterprise'
  | 'startup'
  | 'consulting'
  | 'government'
  | 'investor-pitch'
  | 'corporate';

/** All theme ids, in display order. */
export const THEME_IDS: readonly ThemeId[] = [
  'modern-saas',
  'enterprise',
  'startup',
  'consulting',
  'government',
  'investor-pitch',
  'corporate',
] as const;

/** A resolved color palette (6-digit hex, no `#`). */
export interface ThemePalette {
  /** Primary brand color — title bars, headings, section dividers. */
  primary: string;
  /** Secondary accent — highlights, underlines, second chart series. */
  accent: string;
  /** Dark surface for full-bleed cover/section/closing backgrounds. */
  dark: string;
  /** Body text color on light backgrounds. */
  text: string;
  /** Muted/secondary text. */
  muted: string;
  /** Light page/background fill. */
  light: string;
  /** Card/surface fill (slightly off-light). */
  surface: string;
  /** Hairline/border color. */
  border: string;
  /** Pure white (text on dark surfaces). */
  white: string;
  /** Ordered series colors for charts (≥4). */
  chartSeries: string[];
}

/** Typography for a theme. PPTX uses real font names; PDF maps to core fonts. */
export interface ThemeFonts {
  /** Heading font family name resolved by PowerPoint. */
  pptxHeading: string;
  /** Body font family name resolved by PowerPoint. */
  pptxBody: string;
  /** Heading font for pdfkit (a built-in font). */
  pdfHeading: string;
  /** Body font for pdfkit (a built-in font). */
  pdfBody: string;
  /** Italic body font for pdfkit (a built-in font). */
  pdfItalic: string;
}

/** A complete theme. */
export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  palette: ThemePalette;
  fonts: ThemeFonts;
  /** Cover treatment hint for the renderers. */
  coverStyle: 'split' | 'full' | 'minimal' | 'band';
}

/** The seven built-in themes. */
export const THEMES: Record<ThemeId, Theme> = {
  'modern-saas': {
    id: 'modern-saas',
    name: 'Modern SaaS',
    description: 'Clean indigo/cyan product aesthetic for software & tech.',
    coverStyle: 'split',
    fonts: {
      pptxHeading: 'Arial',
      pptxBody: 'Arial',
      pdfHeading: 'Helvetica-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Helvetica-Oblique',
    },
    palette: {
      primary: '6366F1',
      accent: '06B6D4',
      dark: '0F172A',
      text: '1E293B',
      muted: '64748B',
      light: 'F8FAFC',
      surface: 'F1F5F9',
      border: 'E2E8F0',
      white: 'FFFFFF',
      chartSeries: ['6366F1', '06B6D4', '8B5CF6', '22D3EE', 'A855F7', '14B8A6'],
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Deep blue, steel & sky — trusted, large-organization feel.',
    coverStyle: 'band',
    fonts: {
      pptxHeading: 'Calibri',
      pptxBody: 'Calibri',
      pdfHeading: 'Helvetica-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Helvetica-Oblique',
    },
    palette: {
      primary: '1E3A8A',
      accent: '0EA5E9',
      dark: '0B1F3A',
      text: '1F2937',
      muted: '6B7280',
      light: 'F9FAFB',
      surface: 'EFF3F8',
      border: 'D8E0EA',
      white: 'FFFFFF',
      chartSeries: ['1E3A8A', '0EA5E9', '3B82F6', '60A5FA', '0369A1', '38BDF8'],
    },
  },
  startup: {
    id: 'startup',
    name: 'Startup',
    description: 'Bold violet, amber & pink — energetic, modern, ambitious.',
    coverStyle: 'full',
    fonts: {
      pptxHeading: 'Trebuchet MS',
      pptxBody: 'Verdana',
      pdfHeading: 'Helvetica-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Helvetica-Oblique',
    },
    palette: {
      primary: '7C3AED',
      accent: 'F59E0B',
      dark: '18181B',
      text: '27272A',
      muted: '71717A',
      light: 'FAFAFA',
      surface: 'F4F4F5',
      border: 'E4E4E7',
      white: 'FFFFFF',
      chartSeries: ['7C3AED', 'F59E0B', 'EC4899', '8B5CF6', 'FB923C', 'F472B6'],
    },
  },
  consulting: {
    id: 'consulting',
    name: 'Consulting',
    description: 'Navy & gold, serif headings — McKinsey/Bain board-grade.',
    coverStyle: 'split',
    fonts: {
      pptxHeading: 'Georgia',
      pptxBody: 'Arial',
      pdfHeading: 'Times-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Times-Italic',
    },
    palette: {
      primary: '0F2A4A',
      accent: 'C8A451',
      dark: '0A1A2F',
      text: '1C2A3A',
      muted: '5B6B7B',
      light: 'F7F8FA',
      surface: 'EEF1F5',
      border: 'DCE2E9',
      white: 'FFFFFF',
      chartSeries: ['0F2A4A', 'C8A451', '2F5277', '9C7A2E', '4A6B8F', 'E0C173'],
    },
  },
  government: {
    id: 'government',
    name: 'Government Proposal',
    description: 'Formal navy & red, serif body — public-sector / grant style.',
    coverStyle: 'band',
    fonts: {
      pptxHeading: 'Times New Roman',
      pptxBody: 'Times New Roman',
      pdfHeading: 'Times-Bold',
      pdfBody: 'Times-Roman',
      pdfItalic: 'Times-Italic',
    },
    palette: {
      primary: '1B3A6B',
      accent: 'B22234',
      dark: '102A4C',
      text: '1A1A1A',
      muted: '555555',
      light: 'FBFBFB',
      surface: 'F0F2F5',
      border: 'D5DAE0',
      white: 'FFFFFF',
      chartSeries: ['1B3A6B', 'B22234', '3C5A88', '8E1B29', '6B7F9E', 'C8505C'],
    },
  },
  'investor-pitch': {
    id: 'investor-pitch',
    name: 'Investor Pitch',
    description: 'Bold near-black & emerald — high-contrast fundraising decks.',
    coverStyle: 'full',
    fonts: {
      pptxHeading: 'Arial',
      pptxBody: 'Arial',
      pdfHeading: 'Helvetica-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Helvetica-Oblique',
    },
    palette: {
      primary: '111827',
      accent: '10B981',
      dark: '0A0F1A',
      text: '111827',
      muted: '6B7280',
      light: 'F9FAFB',
      surface: 'F3F4F6',
      border: 'E5E7EB',
      white: 'FFFFFF',
      chartSeries: ['10B981', '34D399', '059669', '6EE7B7', '047857', 'A7F3D0'],
    },
  },
  corporate: {
    id: 'corporate',
    name: 'Corporate',
    description: 'Classic professional blue & grey for any business document.',
    coverStyle: 'split',
    fonts: {
      pptxHeading: 'Calibri',
      pptxBody: 'Calibri',
      pdfHeading: 'Helvetica-Bold',
      pdfBody: 'Helvetica',
      pdfItalic: 'Helvetica-Oblique',
    },
    palette: {
      primary: '1F4E79',
      accent: '2E75B6',
      dark: '15334F',
      text: '212529',
      muted: '6C757D',
      light: 'F8F9FA',
      surface: 'EDF1F5',
      border: 'DEE2E6',
      white: 'FFFFFF',
      chartSeries: ['1F4E79', '2E75B6', '5B9BD5', '9DC3E6', '2F5496', '8FAADC'],
    },
  },
};

/** Resolve a theme by id, defaulting to Corporate when unknown. */
export function resolveTheme(id: string | undefined): Theme {
  if (id !== undefined && id in THEMES) return THEMES[id as ThemeId];
  return THEMES.corporate;
}

/**
 * Apply brand overrides (primary/accent) on top of a theme, returning a new
 * theme object so the base palette is never mutated.
 */
export function applyBrand(theme: Theme, brand: BrandSpec | undefined): Theme {
  if (brand === undefined) return theme;
  const primary = normalizeHex(brand.primaryColor) ?? theme.palette.primary;
  const accent = normalizeHex(brand.accentColor) ?? theme.palette.accent;
  if (primary === theme.palette.primary && accent === theme.palette.accent) return theme;
  return {
    ...theme,
    palette: {
      ...theme.palette,
      primary,
      accent,
      chartSeries: [primary, accent, ...theme.palette.chartSeries.slice(2)],
    },
  };
}

/** Coerce a user-supplied color to clean 6-digit hex (no `#`), or undefined. */
export function normalizeHex(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  let v = value.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
  return /^[0-9A-F]{6}$/.test(v) ? v : undefined;
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Structured document spec — the AI's design output
 * ────────────────────────────────────────────────────────────────────────── */

/** A chart the renderers draw natively. */
export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'doughnut';
  title?: string;
  /** X-axis / slice labels. */
  categories: string[];
  /** One or more data series (pie/doughnut use the first series only). */
  series: { name: string; values: number[] }[];
}

/** A single KPI / metric tile. */
export interface KpiSpec {
  /** The metric label, e.g. "ARR". */
  label: string;
  /** The headline value, e.g. "$4.2M". */
  value: string;
  /** Optional supporting line, e.g. "+38% YoY". */
  sub?: string;
}

/** A timeline / roadmap milestone. */
export interface TimelineItem {
  /** Date or phase label, e.g. "Q3 2026". */
  date: string;
  /** Milestone title. */
  title: string;
  /** Optional detail. */
  detail?: string;
}

/** One column in a two-column or comparison layout. */
export interface ColumnSpec {
  heading?: string;
  bullets?: string[];
  body?: string;
}

/** A highlighted callout box. */
export interface CalloutSpec {
  variant: 'info' | 'success' | 'warning' | 'highlight';
  title?: string;
  text: string;
}

/** The visual layout of a section / slide. */
export type SectionLayout =
  | 'cover'
  | 'section-divider'
  | 'bullets'
  | 'paragraph'
  | 'two-column'
  | 'comparison'
  | 'table'
  | 'chart'
  | 'kpis'
  | 'timeline'
  | 'quote'
  | 'callout'
  | 'closing';

/** One section of the document (one slide in a deck, one block in a doc). */
export interface DocumentSection {
  layout: SectionLayout;
  /** Section/slide title. */
  title?: string;
  /** Optional sub-heading / kicker. */
  subtitle?: string;
  /** Paragraph prose (plain text; light Markdown emphasis is stripped). */
  body?: string;
  /** Bullet points. */
  bullets?: string[];
  /** Columns for two-column / comparison layouts. */
  columns?: ColumnSpec[];
  /** A data table. */
  table?: { header: string[]; rows: string[][] };
  /** A chart specification. */
  chart?: ChartSpec;
  /** KPI tiles. */
  kpis?: KpiSpec[];
  /** Timeline / roadmap milestones. */
  timeline?: TimelineItem[];
  /** A pull-quote. */
  quote?: { text: string; attribution?: string };
  /** A highlighted callout. */
  callout?: CalloutSpec;
  /** Speaker notes (PPTX only). */
  notes?: string;
}

/** Branding applied across the document. */
export interface BrandSpec {
  /** Organization / author name shown on cover + footer. */
  organization?: string;
  /** Primary color override (hex, with or without `#`). */
  primaryColor?: string;
  /** Accent color override (hex, with or without `#`). */
  accentColor?: string;
  /** Footer text (defaults to organization + page number). */
  footer?: string;
  /** A faint diagonal watermark on every page (PDF). */
  watermark?: string;
}

/** The complete, renderable document specification produced by the AI. */
export interface DocumentSpec {
  /** The template/document kind, e.g. `pitch-deck`, `grant-proposal`. */
  docType: string;
  /** The chosen theme id. */
  themeId: ThemeId;
  /** Document title (cover). */
  title: string;
  /** Document subtitle (cover). */
  subtitle?: string;
  /** Author / presenter. */
  author?: string;
  /** Date string (defaults to today). */
  date?: string;
  /** Branding overrides. */
  brand?: BrandSpec;
  /** The ordered sections. */
  sections: DocumentSection[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Template library — reusable document blueprints
 * ────────────────────────────────────────────────────────────────────────── */

/** A reusable document blueprint the AI can select and fill in. */
export interface DocumentTemplate {
  /** Stable id used as {@link DocumentSpec.docType}. */
  id: string;
  /** Human label. */
  name: string;
  /** One-line description for selection. */
  description: string;
  /** The default theme for this template. */
  defaultTheme: ThemeId;
  /** The best output format for this template. */
  preferredFormat: 'pptx' | 'pdf' | 'docx';
  /** Ordered section layouts that define this blueprint's structure. */
  outline: SectionLayout[];
  /** Author guidance injected into the AI prompt for this template. */
  guidance: string;
}

/**
 * The seeded template registry. This is intentionally data-driven so the
 * library can grow toward 100+ blueprints without code changes — each entry is
 * a structural blueprint plus AI guidance, and {@link selectTemplate} picks the
 * best match for a prompt.
 */
export const TEMPLATES: DocumentTemplate[] = [
  {
    id: 'pitch-deck',
    name: 'Startup Pitch Deck',
    description: 'Investor pitch: problem, solution, market, traction, ask.',
    defaultTheme: 'investor-pitch',
    preferredFormat: 'pptx',
    outline: ['cover', 'bullets', 'bullets', 'chart', 'kpis', 'bullets', 'timeline', 'table', 'closing'],
    guidance:
      'A fundraising pitch deck. Cover → Problem → Solution → Market size (chart) → Traction (KPIs) → ' +
      'Business model → Roadmap (timeline) → Team / Use of funds (table) → The Ask (closing). ' +
      'Punchy, confident, metric-driven. 10–14 slides.',
  },
  {
    id: 'sales-deck',
    name: 'Sales Deck',
    description: 'Customer-facing deck: pain, value, proof, pricing.',
    defaultTheme: 'modern-saas',
    preferredFormat: 'pptx',
    outline: ['cover', 'bullets', 'two-column', 'kpis', 'chart', 'table', 'quote', 'closing'],
    guidance:
      'A B2B sales deck. Lead with the customer pain, present the value proposition, show proof ' +
      '(metrics, a customer quote), a comparison, pricing table, and a clear call to action.',
  },
  {
    id: 'grant-proposal',
    name: 'Grant Proposal',
    description: 'Funding proposal: need, objectives, methodology, budget.',
    defaultTheme: 'government',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'bullets', 'bullets', 'timeline', 'table', 'kpis', 'paragraph'],
    guidance:
      'A formal grant proposal. Executive summary, statement of need, goals & objectives, methodology/' +
      'work plan, timeline, detailed budget table, expected outcomes / evaluation metrics, and ' +
      'organizational capacity. Formal, evidence-based, persuasive. Aim for the requested page count.',
  },
  {
    id: 'business-proposal',
    name: 'Business Proposal',
    description: 'Commercial proposal: scope, approach, pricing, terms.',
    defaultTheme: 'corporate',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'bullets', 'two-column', 'table', 'timeline', 'callout', 'paragraph'],
    guidance:
      'A commercial business proposal. Executive summary, understanding of needs, proposed approach, ' +
      'deliverables, pricing table, timeline, terms, and next steps.',
  },
  {
    id: 'research-report',
    name: 'Research Report',
    description: 'Analytical report: findings, data, analysis, recommendations.',
    defaultTheme: 'consulting',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'kpis', 'chart', 'bullets', 'table', 'chart', 'paragraph'],
    guidance:
      'A data-driven research report. Executive summary, key findings (KPIs), data analysis with charts, ' +
      'detailed discussion, supporting tables, and conclusions / recommendations. Rigorous and objective.',
  },
  {
    id: 'business-report',
    name: 'Business / Annual Report',
    description: 'Performance report: results, metrics, outlook.',
    defaultTheme: 'enterprise',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'kpis', 'chart', 'two-column', 'table', 'chart', 'paragraph'],
    guidance:
      'A business or annual report. Leadership summary, performance highlights (KPIs + charts), ' +
      'segment results, financial tables, and forward outlook. Polished and confident.',
  },
  {
    id: 'company-profile',
    name: 'Company Profile',
    description: 'Corporate overview: mission, offerings, clients, contact.',
    defaultTheme: 'corporate',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'bullets', 'kpis', 'two-column', 'quote', 'callout'],
    guidance:
      'A company profile / capability statement. Mission & vision, what we do, key numbers, ' +
      'differentiators, a client testimonial, and contact details.',
  },
  {
    id: 'product-brochure',
    name: 'Product Brochure',
    description: 'Product one-pager: features, benefits, pricing.',
    defaultTheme: 'modern-saas',
    preferredFormat: 'pdf',
    outline: ['cover', 'bullets', 'two-column', 'kpis', 'table', 'callout'],
    guidance:
      'A product brochure. Hero value proposition, key features & benefits, comparison, pricing tiers, ' +
      'and a strong closing call to action. Vivid and benefit-led.',
  },
  {
    id: 'whitepaper',
    name: 'Whitepaper',
    description: 'Thought-leadership: thesis, evidence, framework.',
    defaultTheme: 'consulting',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'paragraph', 'chart', 'bullets', 'callout', 'paragraph'],
    guidance:
      'An authoritative whitepaper. Abstract, problem framing, an original framework or argument backed ' +
      'by data/charts, implications, and a conclusion. Intellectual and well-structured.',
  },
  {
    id: 'case-study',
    name: 'Case Study',
    description: 'Success story: challenge, solution, results.',
    defaultTheme: 'modern-saas',
    preferredFormat: 'pdf',
    outline: ['cover', 'paragraph', 'two-column', 'kpis', 'chart', 'quote', 'callout'],
    guidance:
      'A customer case study. Background, the challenge, the solution delivered, measurable results ' +
      '(KPIs + chart), a customer quote, and a takeaway. Concrete and results-focused.',
  },
  {
    id: 'marketing-plan',
    name: 'Marketing Plan',
    description: 'Go-to-market: strategy, channels, budget, KPIs.',
    defaultTheme: 'startup',
    preferredFormat: 'pptx',
    outline: ['cover', 'bullets', 'two-column', 'chart', 'timeline', 'kpis', 'table', 'closing'],
    guidance:
      'A marketing / go-to-market plan. Goals, target segments & positioning, channel strategy, ' +
      'campaign calendar (timeline), budget table, and success metrics (KPIs).',
  },
  {
    id: 'executive-briefing',
    name: 'Executive Briefing',
    description: 'Concise board / leadership briefing deck.',
    defaultTheme: 'enterprise',
    preferredFormat: 'pptx',
    outline: ['cover', 'kpis', 'chart', 'bullets', 'comparison', 'callout', 'closing'],
    guidance:
      'A crisp executive briefing for a board or leadership team. Situation summary, key metrics, ' +
      'one decisive chart, options/recommendation (comparison), risks, and the decision requested.',
  },
];

/** Keyword → template id hints for fast, deterministic selection. */
const TEMPLATE_HINTS: { id: string; re: RegExp }[] = [
  { id: 'pitch-deck', re: /\b(pitch\s*deck|investor|fundrais|seed|series\s*[a-d]|raise|vc\b|venture)/i },
  { id: 'grant-proposal', re: /\b(grant|funding\s*proposal|rfp|rfa|nonprofit|foundation\s*proposal)/i },
  { id: 'sales-deck', re: /\b(sales\s*deck|sales\s*present|prospect|demo\s*deck)/i },
  { id: 'business-proposal', re: /\b(business\s*proposal|commercial\s*proposal|sow|statement\s*of\s*work|quote\b|bid\b)/i },
  { id: 'research-report', re: /\b(research\s*report|study|analysis\s*report|findings|whitepaper\s*study)/i },
  { id: 'business-report', re: /\b(annual\s*report|business\s*report|quarterly|performance\s*report|earnings)/i },
  { id: 'company-profile', re: /\b(company\s*profile|capability\s*statement|about\s*us|corporate\s*overview)/i },
  { id: 'product-brochure', re: /\b(brochure|product\s*sheet|one[-\s]*pager|datasheet|flyer)/i },
  { id: 'whitepaper', re: /\b(whitepaper|white\s*paper|thought\s*leadership)/i },
  { id: 'case-study', re: /\b(case\s*study|success\s*story|customer\s*story)/i },
  { id: 'marketing-plan', re: /\b(marketing\s*plan|go[-\s]*to[-\s]*market|gtm|campaign\s*plan)/i },
  { id: 'executive-briefing', re: /\b(executive\s*brief|board\s*deck|leadership\s*brief|briefing)/i },
];

/**
 * Pick the best-fitting template for a free-text prompt. Deterministic keyword
 * matching keeps selection fast and predictable; the AI can still override the
 * theme. Falls back to a research report (the most general blueprint).
 */
export function selectTemplate(prompt: string): DocumentTemplate {
  for (const hint of TEMPLATE_HINTS) {
    if (hint.re.test(prompt)) {
      const t = TEMPLATES.find((x) => x.id === hint.id);
      if (t !== undefined) return t;
    }
  }
  // Generic deck vs document fallback.
  if (/\b(deck|slides?|presentation|powerpoint|pptx)\b/i.test(prompt)) {
    return TEMPLATES.find((t) => t.id === 'executive-briefing')!;
  }
  return TEMPLATES.find((t) => t.id === 'research-report')!;
}

/** Look up a template by id, or undefined. */
export function getTemplate(id: string | undefined): DocumentTemplate | undefined {
  if (id === undefined) return undefined;
  return TEMPLATES.find((t) => t.id === id);
}
