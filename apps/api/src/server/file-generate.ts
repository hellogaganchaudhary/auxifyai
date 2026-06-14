/**
 * Server-side document generation — the "create any kind of file" capability.
 *
 * Turns Markdown (the natural format a chat model produces) into a real,
 * downloadable office document: PDF, Word (.docx), PowerPoint (.pptx), Excel
 * (.xlsx), or a plain text/markdown/html/csv file. The model writes normal
 * Markdown; this module parses it into a small block model and renders that
 * model into the requested binary format.
 *
 * Every heavy renderer (`pdfkit`, `docx`, `pptxgenjs`, `xlsx`) is imported
 * lazily so a single format's dependency is only loaded when that format is
 * actually requested, and a failure in one never blocks the others.
 */

import { marked, type Token, type Tokens } from 'marked';

import {
  applyBrand,
  resolveTheme,
  type ChartSpec,
  type DocumentSection,
  type DocumentSpec,
  type KpiSpec,
  type Theme,
  type TimelineItem,
} from './document-design';

/** The file formats the generator can produce. */
export type FileFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'md' | 'html' | 'txt' | 'csv';

/** All supported {@link FileFormat} values. */
export const FILE_FORMATS: readonly FileFormat[] = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'md',
  'html',
  'txt',
  'csv',
] as const;

/** A request to generate one document. */
export interface GenerateFileInput {
  /** The output format. */
  format: FileFormat;
  /** The document title (used for the filename and the cover/first heading). */
  title?: string;
  /** The Markdown body the document is rendered from. */
  markdown: string;
}

/** A generated document, returned base64-encoded for JSON transport. */
export interface GeneratedFile {
  /** The suggested file name including extension. */
  filename: string;
  /** The file MIME type. */
  mimeType: string;
  /** Base64-encoded file bytes. */
  base64: string;
}

/** The block model the renderers consume (a normalized subset of Markdown). */
type DocBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' };

/** MIME type per format. */
const MIME: Record<FileFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  html: 'text/html',
  txt: 'text/plain',
  csv: 'text/csv',
};

/** Strip inline Markdown emphasis/links to plain text for renderers that need it. */
function inlineText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

/** Read a `{ text }`-ish cell from marked's table tokens. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return inlineText(cell);
  if (cell !== null && typeof cell === 'object' && 'text' in cell) {
    return inlineText(String((cell as { text: unknown }).text ?? ''));
  }
  return '';
}

/** Parse Markdown into the normalized {@link DocBlock} model. */
function parseMarkdown(markdown: string): DocBlock[] {
  const tokens = marked.lexer(markdown);
  const blocks: DocBlock[] = [];

  for (const token of tokens as Token[]) {
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        blocks.push({ kind: 'heading', level: t.depth, text: inlineText(t.text) });
        break;
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph;
        blocks.push({ kind: 'paragraph', text: inlineText(t.text) });
        break;
      }
      case 'list': {
        const t = token as Tokens.List;
        const items = t.items.map((item) => inlineText(item.text));
        blocks.push({ kind: 'list', ordered: Boolean(t.ordered), items });
        break;
      }
      case 'code': {
        const t = token as Tokens.Code;
        blocks.push({ kind: 'code', lang: t.lang ?? '', text: t.text });
        break;
      }
      case 'table': {
        const t = token as Tokens.Table;
        const header = t.header.map((c) => cellText(c));
        const rows = t.rows.map((row) => row.map((c) => cellText(c)));
        blocks.push({ kind: 'table', header, rows });
        break;
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote;
        blocks.push({ kind: 'quote', text: inlineText(t.text) });
        break;
      }
      case 'hr':
        blocks.push({ kind: 'hr' });
        break;
      default:
        // 'space', 'html', etc. carry no renderable block for our model.
        break;
    }
  }

  return blocks;
}

/** A safe, filesystem-friendly base name derived from the title. */
function safeBaseName(title: string | undefined): string {
  const base = (title ?? 'document').trim() || 'document';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document';
}

/** Collect a Node stream-style emitter (pdfkit) into a single Buffer. */
function streamToBuffer(doc: NodeJS.ReadableStream & { end: () => void }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Render the block model to a PDF (pdfkit). */
async function renderPdf(blocks: DocBlock[], title: string | undefined): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const done = streamToBuffer(doc as unknown as NodeJS.ReadableStream & { end: () => void });

  if (title !== undefined && title.length > 0) {
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#111111').text(title);
    doc.moveDown(0.8);
  }

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const size = block.level <= 1 ? 20 : block.level === 2 ? 16 : 13;
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(size).fillColor('#111111').text(block.text);
        doc.moveDown(0.2);
        break;
      }
      case 'paragraph':
        doc.font('Helvetica').fontSize(11).fillColor('#222222').text(block.text, { align: 'left' });
        doc.moveDown(0.5);
        break;
      case 'list':
        doc.font('Helvetica').fontSize(11).fillColor('#222222');
        block.items.forEach((item, i) => {
          const bullet = block.ordered ? `${i + 1}. ` : '•  ';
          doc.text(`${bullet}${item}`, { indent: 14 });
        });
        doc.moveDown(0.5);
        break;
      case 'code':
        doc.font('Courier').fontSize(9.5).fillColor('#0a3d2a').text(block.text, {
          indent: 10,
        });
        doc.moveDown(0.5);
        break;
      case 'quote':
        doc.font('Helvetica-Oblique').fontSize(11).fillColor('#555555').text(block.text, { indent: 14 });
        doc.moveDown(0.5);
        break;
      case 'table': {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text(block.header.join('   |   '));
        doc.font('Helvetica').fontSize(10).fillColor('#333333');
        for (const row of block.rows) {
          doc.text(row.join('   |   '));
        }
        doc.moveDown(0.6);
        break;
      }
      case 'hr':
        doc.moveDown(0.3);
        doc
          .strokeColor('#cccccc')
          .lineWidth(1)
          .moveTo(doc.x, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .stroke();
        doc.moveDown(0.5);
        break;
    }
  }

  return done;
}

/** Render the block model to a Word document (docx). */
async function renderDocx(blocks: DocBlock[], title: string | undefined): Promise<Buffer> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } =
    docx;

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

  if (title !== undefined && title.length > 0) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }

  const headingLevelFor = (level: number) =>
    level <= 1
      ? HeadingLevel.HEADING_1
      : level === 2
        ? HeadingLevel.HEADING_2
        : level === 3
          ? HeadingLevel.HEADING_3
          : HeadingLevel.HEADING_4;

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        children.push(new Paragraph({ text: block.text, heading: headingLevelFor(block.level) }));
        break;
      case 'paragraph':
        children.push(new Paragraph({ children: [new TextRun(block.text)] }));
        break;
      case 'list':
        block.items.forEach((item) => {
          children.push(
            new Paragraph({
              text: item,
              bullet: block.ordered ? undefined : { level: 0 },
              ...(block.ordered ? { numbering: { reference: 'ordered', level: 0 } } : {}),
            }),
          );
        });
        break;
      case 'code':
        block.text.split('\n').forEach((line) => {
          children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 18 })] }));
        });
        break;
      case 'quote':
        children.push(new Paragraph({ children: [new TextRun({ text: block.text, italics: true })] }));
        break;
      case 'table':
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: block.header.map(
                  (h) =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
                    }),
                ),
              }),
              ...block.rows.map(
                (row) =>
                  new TableRow({
                    children: row.map(
                      (c) => new TableCell({ children: [new Paragraph({ children: [new TextRun(c)] })] }),
                    ),
                  }),
              ),
            ],
          }),
        );
        children.push(new Paragraph({ text: '' }));
        break;
      case 'hr':
        children.push(new Paragraph({ text: '' }));
        break;
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
//  Consulting-grade PowerPoint renderer
// ---------------------------------------------------------------------------

/** Professional color theme — inspired by top-tier consulting decks. */
const PPTX_THEME = {
  navy:        '0F172A',
  accent:      '2563EB',
  accentLight: '3B82F6',
  dark:        '0F172A',
  body:        '334155',
  subtle:      '64748B',
  lightBg:     'F8FAFC',
  white:       'FFFFFF',
  tableHead:   '1E3A5F',
  tableAlt:    'F1F5F9',
  gold:        'F59E0B',
  dividerBg:   '0F172A',
  coverBar:    '2563EB',
  border:      'E2E8F0',
} as const;

/** Slide specification produced by the structural analysis pass. */
interface SlideSpec {
  type: 'cover' | 'agenda' | 'section' | 'content' | 'table' | 'quote' | 'summary' | 'closing';
  title: string;
  subtitle?: string;
  bullets: string[];
  table?: { header: string[]; rows: string[][] };
  quoteText?: string;
  notes: string[];
  agendaItems?: string[];
}

/** Keywords that flag a closing slide. */
const CLOSING_KEYWORDS = /^(thank\s*you|questions|q\s*[&/]\s*a|contact|next\s*steps|get\s*in\s*touch)/i;
/** Keywords that flag a summary/takeaways slide. */
const SUMMARY_KEYWORDS = /^(key\s*takeaways|summary|conclusion|recommendations|recap|highlights|key\s*findings|key\s*insights)/i;

/** Max bullets per content slide before splitting. */
const MAX_BULLETS = 7;

/**
 * Convert the flat DocBlock array into a structured slide plan. This is the
 * "presentation architecture" pass — it decides slide types, auto-generates
 * an agenda slide, splits oversized content, and routes tables/quotes into
 * dedicated layouts.
 */
function buildSlideSpecs(blocks: DocBlock[], title: string | undefined): SlideSpec[] {
  // Phase 1 — group blocks by H1/H2 boundaries.
  interface RawSlide { heading: string; level: number; blocks: DocBlock[] }
  const groups: RawSlide[] = [];
  let cur: RawSlide | null = null;

  for (const b of blocks) {
    if (b.kind === 'heading' && b.level <= 2) {
      cur = { heading: b.text, level: b.level, blocks: [] };
      groups.push(cur);
    } else {
      if (cur === null) {
        cur = { heading: title ?? 'Overview', level: 2, blocks: [] };
        groups.push(cur);
      }
      cur.blocks.push(b);
    }
  }

  // Phase 2 — classify each group into a SlideSpec.
  const specs: SlideSpec[] = [];
  let isFirst = true;
  const sectionTitles: string[] = [];

  for (const group of groups) {
    const bullets: string[] = [];
    const notes: string[] = [];
    let table: SlideSpec['table'] | undefined;
    let quoteText: string | undefined;

    for (const b of group.blocks) {
      switch (b.kind) {
        case 'heading': bullets.push(b.text); break;
        case 'paragraph': bullets.push(b.text); break;
        case 'list': b.items.forEach((item) => bullets.push(item)); break;
        case 'quote': quoteText = b.text; break;
        case 'code': notes.push(b.text); break;
        case 'table':
          table = { header: b.header, rows: b.rows };
          break;
        case 'hr': break;
      }
    }

    // Cover slide — the first H1 (or first group entirely).
    if (isFirst) {
      isFirst = false;
      const subtitle = bullets.length > 0 ? bullets[0] : undefined;
      specs.push({
        type: 'cover',
        title: group.heading,
        subtitle,
        bullets: [],
        notes,
      });
      continue;
    }

    // H1 → section divider.
    if (group.level === 1) {
      sectionTitles.push(group.heading);
      specs.push({ type: 'section', title: group.heading, bullets: [], notes });
      // If the section divider also had body content, emit a content slide.
      if (bullets.length > 0 || table !== undefined) {
        specs.push(classifyContentSlide(group.heading, bullets, table, quoteText, notes));
      }
      continue;
    }

    // Collect section titles for the agenda from H2.
    sectionTitles.push(group.heading);

    // Classify the H2 group.
    specs.push(classifyContentSlide(group.heading, bullets, table, quoteText, notes));
  }

  // Phase 3 — insert agenda slide after cover when there are enough sections.
  if (sectionTitles.length >= 3) {
    specs.splice(1, 0, {
      type: 'agenda',
      title: 'Agenda',
      bullets: [],
      notes: [],
      agendaItems: sectionTitles,
    });
  }

  // Phase 4 — split oversized content slides.
  const final: SlideSpec[] = [];
  for (const spec of specs) {
    if (spec.type === 'content' && spec.bullets.length > MAX_BULLETS) {
      const chunks = chunkArray(spec.bullets, MAX_BULLETS);
      chunks.forEach((chunk, i) => {
        final.push({
          ...spec,
          title: chunks.length > 1 && i > 0 ? `${spec.title} (cont'd)` : spec.title,
          bullets: chunk,
          notes: i === 0 ? spec.notes : [],
        });
      });
    } else {
      final.push(spec);
    }
  }

  return final;
}

/** Classify a body group into a specific slide type. */
function classifyContentSlide(
  heading: string,
  bullets: string[],
  table: SlideSpec['table'] | undefined,
  quoteText: string | undefined,
  notes: string[],
): SlideSpec {
  if (CLOSING_KEYWORDS.test(heading)) {
    return { type: 'closing', title: heading, bullets, notes };
  }
  if (SUMMARY_KEYWORDS.test(heading)) {
    return { type: 'summary', title: heading, bullets, notes };
  }
  if (quoteText !== undefined && bullets.length <= 2) {
    return { type: 'quote', title: heading, quoteText, bullets, notes };
  }
  if (table !== undefined) {
    return { type: 'table', title: heading, bullets, table, notes };
  }
  return { type: 'content', title: heading, bullets, notes };
}

/** Split an array into chunks of a given size. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Add a slide-number footer to content slides. */
function addSlideNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slide: any,
  slideNum: number,
  total: number,
): void {
  slide.addText(`${slideNum} / ${total}`, {
    x: 12.0,
    y: 7.0,
    w: 1.2,
    h: 0.4,
    fontSize: 9,
    color: PPTX_THEME.subtle,
    align: 'right',
  });
}

/** Render the block model to a consulting-grade PowerPoint deck (pptxgenjs). */
async function renderPptx(blocks: DocBlock[], title: string | undefined): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 inches

  const specs = buildSlideSpecs(blocks, title);
  const totalSlides = specs.length;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const s = pptx.addSlide();
    const slideNum = i + 1;

    switch (spec.type) {
      // ── Cover slide ──────────────────────────────────────────────────────
      case 'cover': {
        s.background = { color: PPTX_THEME.white };
        // Accent bar at bottom.
        s.addShape(pptx.ShapeType.rect, {
          x: 0, y: 6.9, w: 13.33, h: 0.6,
          fill: { color: PPTX_THEME.accent },
        });
        // Left accent strip.
        s.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: 0.15, h: 7.5,
          fill: { color: PPTX_THEME.navy },
        });
        // Title.
        s.addText(spec.title, {
          x: 0.8, y: 2.0, w: 11.5, h: 1.8,
          fontSize: 44, bold: true, color: PPTX_THEME.dark,
          valign: 'bottom',
        });
        // Accent line under title.
        s.addShape(pptx.ShapeType.line, {
          x: 0.85, y: 3.85, w: 3.5, h: 0,
          line: { color: PPTX_THEME.accent, width: 4 },
        });
        // Subtitle.
        if (spec.subtitle !== undefined && spec.subtitle.length > 0) {
          s.addText(spec.subtitle, {
            x: 0.85, y: 4.1, w: 10, h: 0.8,
            fontSize: 18, color: PPTX_THEME.subtle,
          });
        }
        // Date.
        s.addText(new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), {
          x: 0.85, y: 5.2, w: 4, h: 0.5,
          fontSize: 12, color: PPTX_THEME.subtle,
        });
        break;
      }

      // ── Agenda slide ─────────────────────────────────────────────────────
      case 'agenda': {
        s.background = { color: PPTX_THEME.white };
        // Title.
        s.addText(spec.title, {
          x: 0.6, y: 0.35, w: 12, h: 0.9,
          fontSize: 28, bold: true, color: PPTX_THEME.dark,
        });
        s.addShape(pptx.ShapeType.line, {
          x: 0.65, y: 1.15, w: 12, h: 0,
          line: { color: PPTX_THEME.accent, width: 2 },
        });
        // Numbered agenda items.
        const items = spec.agendaItems ?? [];
        const agendaRows = items.map((item, idx) => [
          {
            text: `${String(idx + 1).padStart(2, '0')}`,
            options: { fontSize: 20, bold: true, color: PPTX_THEME.accent, align: 'center' as const },
          },
          {
            text: item,
            options: { fontSize: 16, color: PPTX_THEME.body },
          },
        ]);
        if (agendaRows.length > 0) {
          s.addTable(agendaRows, {
            x: 1.0, y: 1.6, w: 11,
            colW: [0.8, 10.2],
            border: { type: 'none' as const },
            rowH: 0.65,
          });
        }
        addSlideNumber(s, slideNum, totalSlides);
        break;
      }

      // ── Section divider ──────────────────────────────────────────────────
      case 'section': {
        s.background = { color: PPTX_THEME.dividerBg };
        // Gold accent bar.
        s.addShape(pptx.ShapeType.rect, {
          x: 0.8, y: 3.9, w: 2.5, h: 0.06,
          fill: { color: PPTX_THEME.gold },
        });
        // Section title.
        s.addText(spec.title, {
          x: 0.8, y: 2.2, w: 11, h: 1.6,
          fontSize: 36, bold: true, color: PPTX_THEME.white,
          valign: 'bottom',
        });
        break;
      }

      // ── Content slide ────────────────────────────────────────────────────
      case 'content': {
        s.background = { color: PPTX_THEME.white };
        // Title bar.
        s.addText(spec.title, {
          x: 0.6, y: 0.3, w: 12, h: 0.85,
          fontSize: 24, bold: true, color: PPTX_THEME.dark,
        });
        s.addShape(pptx.ShapeType.line, {
          x: 0.65, y: 1.1, w: 12, h: 0,
          line: { color: PPTX_THEME.accent, width: 1.5 },
        });
        // Bullets.
        if (spec.bullets.length > 0) {
          s.addText(
            spec.bullets.map((text) => ({
              text: `${text}\n`,
              options: {
                bullet: { type: 'bullet' as const, code: '25CF' },
                color: PPTX_THEME.body,
                fontSize: 14,
                paraSpaceBefore: 2,
                paraSpaceAfter: 6,
                indentLevel: 0,
              },
            })),
            { x: 0.8, y: 1.4, w: 11.5, h: 5.4, valign: 'top' },
          );
        }
        addSlideNumber(s, slideNum, totalSlides);
        if (spec.notes.length > 0) s.addNotes(spec.notes.join('\n\n'));
        break;
      }

      // ── Table slide ──────────────────────────────────────────────────────
      case 'table': {
        s.background = { color: PPTX_THEME.white };
        // Title.
        s.addText(spec.title, {
          x: 0.6, y: 0.3, w: 12, h: 0.85,
          fontSize: 24, bold: true, color: PPTX_THEME.dark,
        });
        s.addShape(pptx.ShapeType.line, {
          x: 0.65, y: 1.1, w: 12, h: 0,
          line: { color: PPTX_THEME.accent, width: 1.5 },
        });
        // Context bullets above the table (if any).
        if (spec.bullets.length > 0) {
          s.addText(
            spec.bullets.map((text) => ({
              text: `${text}\n`,
              options: {
                bullet: { type: 'bullet' as const, code: '25CF' },
                color: PPTX_THEME.body,
                fontSize: 13,
                paraSpaceAfter: 4,
              },
            })),
            { x: 0.8, y: 1.3, w: 11.5, h: 1.2, valign: 'top' },
          );
        }
        // Render real PowerPoint table.
        if (spec.table !== undefined) {
          const tbl = spec.table;
          const headerRow = tbl.header.map((h) => ({
            text: h,
            options: {
              bold: true, fontSize: 11, color: PPTX_THEME.white,
              fill: { color: PPTX_THEME.tableHead },
              align: 'left' as const,
              valign: 'middle' as const,
            },
          }));
          const bodyRows = tbl.rows.map((row, ri) =>
            row.map((cell) => ({
              text: cell,
              options: {
                fontSize: 10.5, color: PPTX_THEME.dark,
                fill: { color: ri % 2 === 0 ? PPTX_THEME.white : PPTX_THEME.tableAlt },
                align: 'left' as const,
                valign: 'middle' as const,
              },
            })),
          );
          const tableY = spec.bullets.length > 0 ? 2.6 : 1.4;
          const tableH = spec.bullets.length > 0 ? 4.3 : 5.5;
          const cols = tbl.header.length;
          const colW = cols > 0 ? Array(cols).fill(11.5 / cols) : undefined;
          s.addTable([headerRow, ...bodyRows], {
            x: 0.8, y: tableY, w: 11.5,
            colW,
            rowH: Math.min(0.45, tableH / (tbl.rows.length + 1)),
            border: { type: 'solid' as const, pt: 0.5, color: PPTX_THEME.border },
          });
        }
        addSlideNumber(s, slideNum, totalSlides);
        if (spec.notes.length > 0) s.addNotes(spec.notes.join('\n\n'));
        break;
      }

      // ── Quote slide ──────────────────────────────────────────────────────
      case 'quote': {
        s.background = { color: PPTX_THEME.lightBg };
        // Large decorative open-quote mark.
        s.addText('\u201C', {
          x: 0.6, y: 0.8, w: 1.5, h: 1.5,
          fontSize: 96, bold: true, color: PPTX_THEME.accent,
        });
        // Quote text.
        s.addText(spec.quoteText ?? '', {
          x: 1.2, y: 2.2, w: 10.5, h: 2.5,
          fontSize: 22, italic: true, color: PPTX_THEME.dark,
          valign: 'top',
        });
        // Attribution / heading as source.
        s.addText(`— ${spec.title}`, {
          x: 1.2, y: 4.8, w: 10.5, h: 0.6,
          fontSize: 14, color: PPTX_THEME.subtle,
          align: 'right',
        });
        // Additional context bullets.
        if (spec.bullets.length > 0) {
          s.addText(
            spec.bullets.map((text) => ({
              text: `${text}\n`,
              options: { fontSize: 13, color: PPTX_THEME.body, paraSpaceAfter: 4 },
            })),
            { x: 1.2, y: 5.5, w: 10.5, h: 1.2, valign: 'top' },
          );
        }
        addSlideNumber(s, slideNum, totalSlides);
        break;
      }

      // ── Summary / key takeaways slide ────────────────────────────────────
      case 'summary': {
        s.background = { color: PPTX_THEME.lightBg };
        // Title.
        s.addText(spec.title, {
          x: 0.6, y: 0.3, w: 12, h: 0.9,
          fontSize: 26, bold: true, color: PPTX_THEME.dark,
        });
        s.addShape(pptx.ShapeType.line, {
          x: 0.65, y: 1.15, w: 12, h: 0,
          line: { color: PPTX_THEME.gold, width: 2.5 },
        });
        // Numbered takeaway points.
        if (spec.bullets.length > 0) {
          const takeawayRows = spec.bullets.map((text, idx) => [
            {
              text: `${idx + 1}`,
              options: {
                fontSize: 18, bold: true, color: PPTX_THEME.white,
                fill: { color: PPTX_THEME.accent },
                align: 'center' as const,
                valign: 'middle' as const,
              },
            },
            {
              text,
              options: {
                fontSize: 14, color: PPTX_THEME.body,
                valign: 'middle' as const,
              },
            },
          ]);
          s.addTable(takeawayRows, {
            x: 0.8, y: 1.5, w: 11.5,
            colW: [0.6, 10.9],
            border: { type: 'none' as const },
            rowH: 0.7,
          });
        }
        addSlideNumber(s, slideNum, totalSlides);
        if (spec.notes.length > 0) s.addNotes(spec.notes.join('\n\n'));
        break;
      }

      // ── Closing / thank you slide ────────────────────────────────────────
      case 'closing': {
        s.background = { color: PPTX_THEME.navy };
        // Accent bar at top.
        s.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: 13.33, h: 0.12,
          fill: { color: PPTX_THEME.accent },
        });
        // Centered title.
        s.addText(spec.title, {
          x: 1, y: 2.0, w: 11.33, h: 1.8,
          fontSize: 40, bold: true, color: PPTX_THEME.white,
          align: 'center', valign: 'middle',
        });
        // Gold divider.
        s.addShape(pptx.ShapeType.line, {
          x: 5.4, y: 4.0, w: 2.5, h: 0,
          line: { color: PPTX_THEME.gold, width: 3 },
        });
        // Additional lines (e.g. contact, next steps).
        if (spec.bullets.length > 0) {
          s.addText(
            spec.bullets.map((text) => ({
              text: `${text}\n`,
              options: { fontSize: 14, color: PPTX_THEME.subtle, align: 'center' as const, paraSpaceAfter: 6 },
            })),
            { x: 2, y: 4.4, w: 9.33, h: 2.2, valign: 'top', align: 'center' },
          );
        }
        break;
      }
    }
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer | ArrayBuffer | Uint8Array;
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/** Render the block model to an Excel workbook (xlsx). Tables → sheets. */
async function renderXlsx(blocks: DocBlock[], title: string | undefined): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();

  const tables = blocks.filter((b): b is Extract<DocBlock, { kind: 'table' }> => b.kind === 'table');

  if (tables.length > 0) {
    tables.forEach((table, i) => {
      const aoa = [table.header, ...table.rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, `Sheet${i + 1}`.slice(0, 31));
    });
  } else {
    // No tables: lay the text content down one row per block as an outline.
    const aoa: string[][] = [];
    if (title !== undefined && title.length > 0) aoa.push([title]);
    for (const block of blocks) {
      if (block.kind === 'heading') aoa.push([block.text]);
      else if (block.kind === 'paragraph' || block.kind === 'quote') aoa.push([block.text]);
      else if (block.kind === 'list') block.items.forEach((item) => aoa.push([item]));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa.length > 0 ? aoa : [['(empty)']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  }

  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/** Escape text for safe interpolation into generated HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip active content from model-authored HTML before it is offered as a
 * download: `marked` does NOT sanitize, and the markdown source is
 * model-generated (attacker-influenceable via prompt injection).
 */
function sanitizeGeneratedHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?\s*(?:script|iframe|object|embed|form)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
}

/** Render a plain-text family format (md/txt/html/csv) to a Buffer. */
function renderText(format: 'md' | 'txt' | 'html' | 'csv', blocks: DocBlock[], markdown: string, title: string | undefined): Buffer {
  if (format === 'md') {
    const head = title !== undefined && title.length > 0 ? `# ${title}\n\n` : '';
    return Buffer.from(head + markdown, 'utf8');
  }
  if (format === 'html') {
    const body = sanitizeGeneratedHtml(marked.parse(markdown, { async: false }) as string);
    const safeTitle = escapeHtml(title ?? 'Document');
    const html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${safeTitle}</title>` +
      `<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}` +
      `pre{background:#f5f5f7;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style>` +
      `</head><body>${title ? `<h1>${escapeHtml(title)}</h1>` : ''}${body}</body></html>`;
    return Buffer.from(html, 'utf8');
  }
  if (format === 'csv') {
    const table = blocks.find((b): b is Extract<DocBlock, { kind: 'table' }> => b.kind === 'table');
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    if (table !== undefined) {
      const lines = [table.header, ...table.rows].map((row) => row.map(escape).join(','));
      return Buffer.from(lines.join('\n'), 'utf8');
    }
    // No table: one column of text lines.
    const lines = blocks
      .flatMap((b) =>
        b.kind === 'list' ? b.items : b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'quote' ? [b.text] : [],
      )
      .map((v) => escape(v));
    return Buffer.from(lines.join('\n'), 'utf8');
  }
  // txt
  const head = title !== undefined && title.length > 0 ? `${title}\n${'='.repeat(title.length)}\n\n` : '';
  return Buffer.from(head + inlineText(markdown), 'utf8');
}

/**
 * Generate a downloadable document from Markdown in the requested format.
 *
 * @throws {Error} when the requested format is not supported.
 */
export async function generateFile(input: GenerateFileInput): Promise<GeneratedFile> {
  const format = input.format;
  if (!FILE_FORMATS.includes(format)) {
    throw new Error(`Unsupported file format "${format}". Supported: ${FILE_FORMATS.join(', ')}.`);
  }
  const markdown = input.markdown ?? '';
  const blocks = parseMarkdown(markdown);
  const base = safeBaseName(input.title);

  let buffer: Buffer;
  switch (format) {
    case 'pdf':
      buffer = await renderPdf(blocks, input.title);
      break;
    case 'docx':
      buffer = await renderDocx(blocks, input.title);
      break;
    case 'pptx':
      buffer = await renderPptx(blocks, input.title);
      break;
    case 'xlsx':
      buffer = await renderXlsx(blocks, input.title);
      break;
    default:
      buffer = renderText(format, blocks, markdown, input.title);
      break;
  }

  return {
    filename: `${base}.${format}`,
    mimeType: MIME[format],
    base64: buffer.toString('base64'),
  };
}

/* ══════════════════════════════════════════════════════════════════════════ *
 *  DESIGNED DOCUMENTS — the Gamma-like, theme-driven renderer.
 *
 *  These functions consume a structured {@link DocumentSpec} (produced by the
 *  AI document engine) instead of raw Markdown, and render fully designed
 *  output: themed cover pages, section dividers, native charts, KPI tiles,
 *  timelines, callouts, comparison cards and branded headers/footers.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Formats the designed-document pipeline can render. */
export type DesignedFormat = 'pptx' | 'pdf' | 'docx';

/** All {@link DesignedFormat} values. */
export const DESIGNED_FORMATS: readonly DesignedFormat[] = ['pptx', 'pdf', 'docx'] as const;

// pptxgenjs does not export friendly slide/instance types; the renderers below
// operate on them structurally.
/* eslint-disable @typescript-eslint/no-explicit-any */
type PptxInstance = any;
type PptxSlide = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Render a structured {@link DocumentSpec} into a downloadable, fully designed
 * document. This is the entry point used by the AI document engine.
 */
export async function renderDesignedDocument(
  spec: DocumentSpec,
  format: DesignedFormat,
): Promise<GeneratedFile> {
  const theme = applyBrand(resolveTheme(spec.themeId), spec.brand);
  const base = safeBaseName(spec.title);

  let buffer: Buffer;
  switch (format) {
    case 'pptx':
      buffer = await renderPptxFromSpec(spec, theme);
      break;
    case 'pdf':
      buffer = await renderPdfFromSpec(spec, theme);
      break;
    case 'docx':
      buffer = await renderDocxFromSpec(spec, theme);
      break;
    default:
      throw new Error(`Unsupported designed format "${format}".`);
  }

  return {
    filename: `${base}.${format}`,
    mimeType: MIME[format as FileFormat],
    base64: buffer.toString('base64'),
  };
}

/* ── PPTX (pptxgenjs) ─────────────────────────────────────────────────────── */

/** Slide dimensions for LAYOUT_WIDE (inches). */
const SLIDE_W = 13.33;
const SLIDE_H = 7.5;

/** Map a callout variant to a theme color (hex, no `#`). */
function calloutColor(theme: Theme, variant: string): string {
  switch (variant) {
    case 'success':
      return '16A34A';
    case 'warning':
      return 'D97706';
    case 'highlight':
      return theme.palette.primary;
    default:
      return theme.palette.accent;
  }
}

/** Build pptxgenjs chart data from a {@link ChartSpec}. */
function pptxChartData(chart: ChartSpec): { name: string; labels: string[]; values: number[] }[] {
  if (chart.type === 'pie' || chart.type === 'doughnut') {
    const first = chart.series[0] ?? { name: 'Series', values: [] };
    return [{ name: first.name, labels: chart.categories, values: first.values }];
  }
  return chart.series.map((s) => ({ name: s.name, labels: chart.categories, values: s.values }));
}

/** Add a native pptx chart inside a box. */
function pptxAddChart(
  pptx: PptxInstance,
  slide: PptxSlide,
  theme: Theme,
  chart: ChartSpec,
  box: { x: number; y: number; w: number; h: number },
): void {
  const data = pptxChartData(chart);
  const typeMap: Record<ChartSpec['type'], string> = {
    bar: pptx.ChartType.bar,
    line: pptx.ChartType.line,
    pie: pptx.ChartType.pie,
    doughnut: pptx.ChartType.doughnut,
  };
  const isPie = chart.type === 'pie' || chart.type === 'doughnut';
  slide.addChart(typeMap[chart.type], data, {
    ...box,
    chartColors: theme.palette.chartSeries,
    showLegend: data.length > 1 || isPie,
    legendPos: 'b',
    legendColor: theme.palette.muted,
    legendFontSize: 10,
    showTitle: false,
    showValue: isPie,
    showPercent: false,
    dataLabelColor: isPie ? theme.palette.white : theme.palette.text,
    dataLabelFontSize: 9,
    catAxisLabelColor: theme.palette.muted,
    catAxisLabelFontSize: 9,
    valAxisLabelColor: theme.palette.muted,
    valAxisLabelFontSize: 9,
    valGridLine: { color: theme.palette.border, style: 'solid', size: 1 },
    catGridLine: { style: 'none' },
    barDir: 'col',
    chartColorsOpacity: 90,
    ...(chart.type === 'doughnut' ? { holeSize: 55 } : {}),
  });
}

/** Add the standard content-slide header (accent tab + title + rule). */
function pptxHeader(slide: PptxSlide, theme: Theme, title: string, subtitle?: string): number {
  const p = theme.palette;
  slide.addShape('rect', { x: 0.5, y: 0.48, w: 0.16, h: 0.52, fill: { color: p.accent } });
  slide.addText(title, {
    x: 0.82, y: 0.4, w: 12.0, h: 0.7,
    fontSize: 26, bold: true, color: p.primary, fontFace: theme.fonts.pptxHeading, valign: 'middle',
  });
  let ruleY = 1.28;
  if (subtitle !== undefined && subtitle.length > 0) {
    slide.addText(subtitle, {
      x: 0.82, y: 1.06, w: 12.0, h: 0.36,
      fontSize: 13, italic: true, color: p.muted, fontFace: theme.fonts.pptxBody,
    });
    ruleY = 1.5;
  }
  slide.addShape('rect', { x: 0.5, y: ruleY, w: 12.33, h: 0.02, fill: { color: p.border } });
  return ruleY + 0.28;
}

/** Add a slim branded footer (org + page number) to a content slide. */
function pptxFooter(slide: PptxSlide, theme: Theme, spec: DocumentSpec, num: number, total: number): void {
  const p = theme.palette;
  const org = spec.brand?.footer ?? spec.brand?.organization ?? spec.author ?? '';
  if (org.length > 0) {
    slide.addText(org, {
      x: 0.5, y: 7.04, w: 9.0, h: 0.34,
      fontSize: 9, color: p.muted, fontFace: theme.fonts.pptxBody, valign: 'middle',
    });
  }
  slide.addText(`${num} / ${total}`, {
    x: 11.2, y: 7.04, w: 1.63, h: 0.34,
    fontSize: 9, color: p.muted, fontFace: theme.fonts.pptxBody, align: 'right', valign: 'middle',
  });
}

/** Render the cover slide. */
function pptxCover(slide: PptxSlide, spec: DocumentSpec, theme: Theme): void {
  const p = theme.palette;
  const date = spec.date ?? '';
  const org = spec.brand?.organization ?? spec.author ?? '';

  if (theme.coverStyle === 'full') {
    slide.background = { color: p.dark };
    slide.addShape('rect', { x: 0.9, y: 2.55, w: 1.7, h: 0.12, fill: { color: p.accent } });
    slide.addText(spec.title, {
      x: 0.9, y: 2.75, w: 11.5, h: 1.9,
      fontSize: 46, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, valign: 'top',
    });
    if (spec.subtitle !== undefined) {
      slide.addText(spec.subtitle, {
        x: 0.92, y: 4.7, w: 10.8, h: 1.0,
        fontSize: 20, color: 'CBD5E1', fontFace: theme.fonts.pptxBody,
      });
    }
    if (org.length > 0) slide.addText(org, { x: 0.92, y: 6.6, w: 8, h: 0.4, fontSize: 13, color: 'E2E8F0', bold: true });
    if (date.length > 0) slide.addText(date, { x: 9.4, y: 6.6, w: 3, h: 0.4, fontSize: 13, color: '94A3B8', align: 'right' });
    return;
  }

  if (theme.coverStyle === 'split') {
    slide.background = { color: p.white };
    slide.addShape('rect', { x: 0, y: 0, w: 4.7, h: SLIDE_H, fill: { color: p.primary } });
    slide.addShape('rect', { x: 4.7, y: 0, w: 0.14, h: SLIDE_H, fill: { color: p.accent } });
    if (org.length > 0) {
      slide.addText(org.toUpperCase(), {
        x: 0.5, y: 0.6, w: 3.8, h: 0.5,
        fontSize: 14, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, charSpacing: 2,
      });
    }
    slide.addText(date, { x: 0.5, y: 6.5, w: 3.8, h: 0.4, fontSize: 12, color: 'E2E8F0' });
    slide.addShape('rect', { x: 5.2, y: 2.55, w: 1.5, h: 0.1, fill: { color: p.accent } });
    slide.addText(spec.title, {
      x: 5.2, y: 2.75, w: 7.6, h: 2.0,
      fontSize: 38, bold: true, color: p.primary, fontFace: theme.fonts.pptxHeading, valign: 'top',
    });
    if (spec.subtitle !== undefined) {
      slide.addText(spec.subtitle, {
        x: 5.22, y: 4.75, w: 7.4, h: 1.2,
        fontSize: 18, color: p.muted, fontFace: theme.fonts.pptxBody,
      });
    }
    return;
  }

  // band / minimal
  slide.background = { color: p.white };
  slide.addShape('rect', { x: 0, y: 2.5, w: SLIDE_W, h: 2.1, fill: { color: p.primary } });
  slide.addShape('rect', { x: 0, y: 4.6, w: SLIDE_W, h: 0.12, fill: { color: p.accent } });
  slide.addText(spec.title, {
    x: 0.9, y: 2.6, w: 11.5, h: 1.9,
    fontSize: 40, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, valign: 'middle',
  });
  if (spec.subtitle !== undefined) {
    slide.addText(spec.subtitle, {
      x: 0.92, y: 4.85, w: 11.5, h: 0.9,
      fontSize: 18, color: p.text, fontFace: theme.fonts.pptxBody,
    });
  }
  if (org.length > 0) slide.addText(org, { x: 0.92, y: 1.7, w: 8, h: 0.4, fontSize: 14, bold: true, color: p.primary });
  if (date.length > 0) slide.addText(date, { x: 9.4, y: 1.7, w: 3, h: 0.4, fontSize: 13, color: p.muted, align: 'right' });
}

/** Render a full-bleed section-divider slide. */
function pptxDivider(slide: PptxSlide, section: DocumentSection, theme: Theme): void {
  const p = theme.palette;
  slide.background = { color: p.dark };
  slide.addShape('rect', { x: 0.9, y: 3.2, w: 1.5, h: 0.12, fill: { color: p.accent } });
  slide.addText(section.title ?? '', {
    x: 0.9, y: 3.4, w: 11.5, h: 1.3,
    fontSize: 34, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, valign: 'top',
  });
  if (section.subtitle !== undefined) {
    slide.addText(section.subtitle, {
      x: 0.92, y: 4.7, w: 11.0, h: 0.8, fontSize: 17, color: 'CBD5E1', fontFace: theme.fonts.pptxBody,
    });
  }
}

/** Render a closing slide. */
function pptxClosing(slide: PptxSlide, spec: DocumentSpec, section: DocumentSection, theme: Theme): void {
  const p = theme.palette;
  slide.background = { color: p.dark };
  slide.addText(section.title ?? 'Thank You', {
    x: 0.9, y: 2.8, w: 11.5, h: 1.4,
    fontSize: 44, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, align: 'center', valign: 'middle',
  });
  slide.addShape('rect', { x: SLIDE_W / 2 - 0.9, y: 4.25, w: 1.8, h: 0.1, fill: { color: p.accent } });
  const contact = section.subtitle ?? spec.brand?.organization ?? spec.author ?? '';
  if (contact.length > 0) {
    slide.addText(contact, {
      x: 0.9, y: 4.55, w: 11.5, h: 0.6, fontSize: 18, color: 'CBD5E1', align: 'center', fontFace: theme.fonts.pptxBody,
    });
  }
  if (section.bullets !== undefined && section.bullets.length > 0) {
    slide.addText(section.bullets.join('   ·   '), {
      x: 0.9, y: 5.3, w: 11.5, h: 0.5, fontSize: 14, color: '94A3B8', align: 'center', fontFace: theme.fonts.pptxBody,
    });
  }
}

/** Render KPI tiles inside the content area. */
function pptxKpis(slide: PptxSlide, kpis: KpiSpec[], theme: Theme, top: number): void {
  const p = theme.palette;
  const n = Math.min(kpis.length, 4);
  const gap = 0.35;
  const totalW = 11.83;
  const cardW = (totalW - gap * (n - 1)) / n;
  const cardH = 2.0;
  const y = Math.max(top, 2.3);
  for (let i = 0; i < n; i++) {
    const k = kpis[i]!;
    const x = 0.5 + i * (cardW + gap);
    slide.addShape('roundRect', { x, y, w: cardW, h: cardH, fill: { color: p.surface }, line: { color: p.border, width: 1 }, rectRadius: 0.08 });
    slide.addShape('rect', { x, y, w: cardW, h: 0.1, fill: { color: p.accent } });
    slide.addText(k.value, {
      x: x + 0.1, y: y + 0.35, w: cardW - 0.2, h: 0.85,
      fontSize: 34, bold: true, color: p.primary, fontFace: theme.fonts.pptxHeading, align: 'center', valign: 'middle',
    });
    slide.addText(k.label.toUpperCase(), {
      x: x + 0.1, y: y + 1.18, w: cardW - 0.2, h: 0.4,
      fontSize: 11, bold: true, color: p.muted, fontFace: theme.fonts.pptxBody, align: 'center', charSpacing: 1,
    });
    if (k.sub !== undefined) {
      slide.addText(k.sub, {
        x: x + 0.1, y: y + 1.55, w: cardW - 0.2, h: 0.35,
        fontSize: 12, bold: true, color: p.accent, fontFace: theme.fonts.pptxBody, align: 'center',
      });
    }
  }
}

/** Render a vertical timeline / roadmap. */
function pptxTimeline(slide: PptxSlide, items: TimelineItem[], theme: Theme, top: number): void {
  const p = theme.palette;
  const n = Math.min(items.length, 6);
  const areaH = 6.5 - top;
  const rowH = Math.min(areaH / n, 0.95);
  slide.addShape('rect', { x: 1.7, y: top + 0.1, w: 0.03, h: rowH * (n - 1) + 0.3, fill: { color: p.border } });
  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    const y = top + i * rowH;
    slide.addShape('ellipse', { x: 1.55, y: y + 0.05, w: 0.33, h: 0.33, fill: { color: p.accent }, line: { color: p.white, width: 2 } });
    slide.addText(it.date, {
      x: 0.5, y: y, w: 1.0, h: 0.45, fontSize: 12, bold: true, color: p.primary, align: 'right', valign: 'top', fontFace: theme.fonts.pptxBody,
    });
    slide.addText(it.title, {
      x: 2.1, y: y - 0.02, w: 10.7, h: 0.4, fontSize: 16, bold: true, color: p.text, fontFace: theme.fonts.pptxHeading,
    });
    if (it.detail !== undefined) {
      slide.addText(it.detail, {
        x: 2.1, y: y + 0.34, w: 10.7, h: 0.4, fontSize: 12, color: p.muted, fontFace: theme.fonts.pptxBody,
      });
    }
  }
}

/** Render two-column or comparison cards. */
function pptxColumns(slide: PptxSlide, section: DocumentSection, theme: Theme, top: number): void {
  const p = theme.palette;
  const cols = (section.columns ?? []).slice(0, 2);
  if (cols.length === 0) return;
  const comparison = section.layout === 'comparison';
  const gap = 0.5;
  const colW = (11.83 - gap) / 2;
  const colH = 6.4 - top;
  cols.forEach((col, i) => {
    const x = 0.5 + i * (colW + gap);
    const headColor = comparison ? (i === 0 ? p.primary : p.accent) : p.primary;
    slide.addShape('roundRect', { x, y: top, w: colW, h: colH, fill: { color: p.surface }, line: { color: p.border, width: 1 }, rectRadius: 0.08 });
    if (col.heading !== undefined) {
      slide.addShape('rect', { x, y: top, w: colW, h: 0.62, fill: { color: headColor } });
      slide.addText(col.heading, {
        x: x + 0.2, y: top, w: colW - 0.4, h: 0.62, fontSize: 16, bold: true, color: p.white, fontFace: theme.fonts.pptxHeading, valign: 'middle',
      });
    }
    const innerY = top + (col.heading !== undefined ? 0.8 : 0.25);
    if (col.bullets !== undefined && col.bullets.length > 0) {
      slide.addText(
        col.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022', indent: 14 }, paraSpaceAfter: 8 } })),
        { x: x + 0.25, y: innerY, w: colW - 0.5, h: colH - (innerY - top) - 0.2, fontSize: 14, color: p.text, fontFace: theme.fonts.pptxBody, valign: 'top' },
      );
    } else if (col.body !== undefined) {
      slide.addText(col.body, {
        x: x + 0.25, y: innerY, w: colW - 0.5, h: colH - (innerY - top) - 0.2, fontSize: 14, color: p.text, fontFace: theme.fonts.pptxBody, valign: 'top',
      });
    }
  });
}

/** Render a themed table. */
function pptxTable(slide: PptxSlide, table: { header: string[]; rows: string[][] }, theme: Theme, top: number): void {
  const p = theme.palette;
  const headRow = table.header.map((h) => ({
    text: h,
    options: { bold: true, color: p.white, fill: { color: p.primary }, align: 'left', valign: 'middle', fontFace: theme.fonts.pptxHeading, fontSize: 13 },
  }));
  const bodyRows = table.rows.map((row, ri) =>
    row.map((cell) => ({
      text: cell,
      options: {
        color: p.text, fill: { color: ri % 2 === 0 ? p.white : p.surface }, align: 'left', valign: 'middle',
        fontFace: theme.fonts.pptxBody, fontSize: 12,
      },
    })),
  );
  slide.addTable([headRow, ...bodyRows], {
    x: 0.5, y: top, w: 11.83, border: { type: 'solid', color: p.border, pt: 1 },
    align: 'left', valign: 'middle', autoPage: false, rowH: 0.4,
  });
}

/** Render a callout box. */
function pptxCallout(slide: PptxSlide, section: DocumentSection, theme: Theme, top: number): void {
  const p = theme.palette;
  const c = section.callout!;
  const color = calloutColor(theme, c.variant);
  const y = Math.max(top, 2.5);
  slide.addShape('roundRect', { x: 1.2, y, w: 10.9, h: 2.2, fill: { color: p.surface }, line: { color, width: 1.5 }, rectRadius: 0.1 });
  slide.addShape('rect', { x: 1.2, y, w: 0.14, h: 2.2, fill: { color } });
  if (c.title !== undefined) {
    slide.addText(c.title, {
      x: 1.6, y: y + 0.25, w: 10.2, h: 0.5, fontSize: 20, bold: true, color, fontFace: theme.fonts.pptxHeading,
    });
  }
  slide.addText(c.text, {
    x: 1.6, y: y + (c.title !== undefined ? 0.85 : 0.4), w: 10.2, h: 1.1, fontSize: 16, color: p.text, fontFace: theme.fonts.pptxBody, valign: 'top',
  });
}

/** Render a pull-quote slide. */
function pptxQuote(slide: PptxSlide, section: DocumentSection, theme: Theme): void {
  const p = theme.palette;
  slide.background = { color: p.light };
  const q = section.quote ?? { text: section.body ?? '' };
  slide.addText('\u201C', {
    x: 0.9, y: 1.2, w: 2, h: 1.6, fontSize: 120, bold: true, color: p.accent, fontFace: theme.fonts.pptxHeading,
  });
  slide.addText(q.text, {
    x: 1.6, y: 2.7, w: 10.1, h: 2.2, fontSize: 26, italic: true, color: p.primary, fontFace: theme.fonts.pptxHeading, valign: 'middle',
  });
  if (q.attribution !== undefined) {
    slide.addText(`— ${q.attribution}`, {
      x: 1.6, y: 5.0, w: 10.1, h: 0.6, fontSize: 16, bold: true, color: p.muted, fontFace: theme.fonts.pptxBody,
    });
  }
}

/** Render a bullets / paragraph content slide body. */
function pptxBody(slide: PptxSlide, section: DocumentSection, theme: Theme, top: number): void {
  const p = theme.palette;
  const h = 6.5 - top;
  if (section.bullets !== undefined && section.bullets.length > 0) {
    slide.addText(
      section.bullets.map((b) => ({
        text: b,
        options: { bullet: { code: '2022', indent: 18 }, paraSpaceAfter: 12, color: p.text },
      })),
      { x: 0.7, y: top, w: 11.9, h, fontSize: 18, color: p.text, fontFace: theme.fonts.pptxBody, valign: 'top', lineSpacingMultiple: 1.1 },
    );
  }
  if (section.body !== undefined) {
    const by = section.bullets !== undefined ? top + h * 0.55 : top;
    slide.addText(section.body, {
      x: 0.7, y: by, w: 11.9, h: section.bullets !== undefined ? h * 0.45 : h,
      fontSize: 16, color: p.text, fontFace: theme.fonts.pptxBody, valign: 'top', lineSpacingMultiple: 1.15, align: 'justify',
    });
  }
}

/** Render a structured {@link DocumentSpec} into a designed PowerPoint deck. */
async function renderPptxFromSpec(spec: DocumentSpec, theme: Theme): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: SLIDE_W, height: SLIDE_H });
  if (spec.author !== undefined) pptx.author = spec.author;
  pptx.title = spec.title;

  const total = spec.sections.length;
  spec.sections.forEach((section, i) => {
    const slide = pptx.addSlide();
    const num = i + 1;

    switch (section.layout) {
      case 'cover':
        pptxCover(slide, spec, theme);
        break;
      case 'section-divider':
        pptxDivider(slide, section, theme);
        break;
      case 'closing':
        pptxClosing(slide, spec, section, theme);
        break;
      case 'quote':
        pptxQuote(slide, section, theme);
        pptxFooter(slide, theme, spec, num, total);
        break;
      default: {
        slide.background = { color: theme.palette.white };
        const top = pptxHeader(slide, theme, section.title ?? '', section.subtitle);
        switch (section.layout) {
          case 'chart':
            if (section.chart !== undefined) pptxAddChart(pptx, slide, theme, section.chart, { x: 0.7, y: top, w: 11.9, h: 5.0 });
            break;
          case 'kpis':
            pptxKpis(slide, section.kpis ?? [], theme, top + 0.3);
            if (section.bullets !== undefined) pptxBody(slide, { ...section, layout: 'bullets', bullets: section.bullets }, theme, top + 2.5);
            break;
          case 'timeline':
            pptxTimeline(slide, section.timeline ?? [], theme, top + 0.1);
            break;
          case 'two-column':
          case 'comparison':
            pptxColumns(slide, section, theme, top);
            break;
          case 'table':
            if (section.bullets !== undefined && section.bullets.length > 0) {
              pptxBody(slide, { layout: 'bullets', bullets: section.bullets.slice(0, 2) }, theme, top);
              if (section.table !== undefined) pptxTable(slide, section.table, theme, top + 1.1);
            } else if (section.table !== undefined) {
              pptxTable(slide, section.table, theme, top + 0.1);
            }
            break;
          case 'callout':
            pptxCallout(slide, section, theme, top);
            break;
          default:
            pptxBody(slide, section, theme, top);
            break;
        }
        pptxFooter(slide, theme, spec, num, total);
        break;
      }
    }

    if (section.notes !== undefined && section.notes.length > 0) slide.addNotes(section.notes);
  });

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return data;
}

/* ── PDF (pdfkit) ─────────────────────────────────────────────────────────── */

/** Add a `#` to a 6-digit hex color for pdfkit. */
function hash(hex: string): string {
  return `#${hex}`;
}

/** Render a structured {@link DocumentSpec} into a designed, branded PDF. */
async function renderPdfFromSpec(spec: DocumentSpec, theme: Theme): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const p = theme.palette;
  const f = theme.fonts;
  const M = { top: 92, bottom: 64, left: 56, right: 56 };
  const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true });
  // Collect chunks and finalize explicitly AFTER all rendering (including the
  // per-page watermark/footer passes), so no operation writes past stream EOF.
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const PW = doc.page.width;
  const PH = doc.page.height;
  const CW = PW - M.left - M.right;
  const org = spec.brand?.organization ?? spec.author ?? '';

  /** Make sure `h` points fit below the cursor; add a page otherwise. */
  const ensure = (h: number): void => {
    if (doc.y + h > PH - M.bottom) doc.addPage();
  };

  // ── Cover page (drawn before the running-header hook is registered) ────────
  const date = spec.date ?? '';
  if (theme.coverStyle === 'split') {
    doc.save().rect(0, 0, PW * 0.4, PH).fill(hash(p.primary));
    doc.rect(PW * 0.4, 0, 5, PH).fill(hash(p.accent)).restore();
    if (org.length > 0) {
      doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(13).text(org.toUpperCase(), 40, 70, { width: PW * 0.4 - 70, characterSpacing: 1 });
    }
    doc.fillColor(hash(p.white)).font(f.pdfBody).fontSize(11).text(date, 40, PH - 80, { width: PW * 0.4 - 70 });
    const tx = PW * 0.4 + 36;
    doc.save().rect(tx, PH / 2 - 120, 46, 5).fill(hash(p.accent)).restore();
    doc.fillColor(hash(p.primary)).font(f.pdfHeading).fontSize(30).text(spec.title, tx, PH / 2 - 100, { width: PW - tx - M.right });
    if (spec.subtitle !== undefined) {
      doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(15).text(spec.subtitle, tx, doc.y + 12, { width: PW - tx - M.right });
    }
  } else if (theme.coverStyle === 'full') {
    doc.save().rect(0, 0, PW, PH).fill(hash(p.dark)).restore();
    doc.save().rect(M.left, PH / 2 - 110, 52, 6).fill(hash(p.accent)).restore();
    doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(34).text(spec.title, M.left, PH / 2 - 86, { width: CW });
    if (spec.subtitle !== undefined) {
      doc.fillColor('#CBD5E1').font(f.pdfBody).fontSize(16).text(spec.subtitle, M.left, doc.y + 14, { width: CW });
    }
    if (org.length > 0) doc.fillColor('#E2E8F0').font(f.pdfHeading).fontSize(13).text(org, M.left, PH - 90, { width: CW });
    if (date.length > 0) doc.fillColor('#94A3B8').font(f.pdfBody).fontSize(12).text(date, M.left, PH - 70, { width: CW });
  } else {
    // band / minimal
    const bandY = PH / 2 - 90;
    doc.save().rect(0, bandY, PW, 150).fill(hash(p.primary));
    doc.rect(0, bandY + 150, PW, 6).fill(hash(p.accent)).restore();
    if (org.length > 0) doc.fillColor(hash(p.primary)).font(f.pdfHeading).fontSize(14).text(org, M.left, bandY - 44, { width: CW });
    doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(30).text(spec.title, M.left, bandY + 34, { width: CW });
    if (spec.subtitle !== undefined) {
      doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(15).text(spec.subtitle, M.left, bandY + 172, { width: CW });
    }
    if (date.length > 0) doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(12).text(date, M.left, bandY - 44, { width: CW, align: 'right' });
  }

  // Optional watermark on the cover too.
  const drawWatermark = (): void => {
    if (spec.brand?.watermark === undefined) return;
    doc.save();
    doc.rotate(-30, { origin: [PW / 2, PH / 2] });
    doc.fillColor(hash(p.border)).font(f.pdfHeading).fontSize(72).opacity(0.18)
      .text(spec.brand.watermark, 0, PH / 2 - 40, { width: PW, align: 'center' });
    doc.opacity(1).restore();
  };

  // ── Running header on every CONTENT page (registered after the cover) ──────
  doc.on('pageAdded', () => {
    doc.save().rect(0, 0, PW, 6).fill(hash(p.primary)).restore();
    doc.fillColor(hash(p.muted)).font(f.pdfHeading).fontSize(9)
      .text(spec.title, M.left, 32, { width: CW * 0.7, lineBreak: false, ellipsis: true });
    if (org.length > 0) {
      doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(9)
        .text(org, M.left + CW * 0.7, 32, { width: CW * 0.3, align: 'right', lineBreak: false, ellipsis: true });
    }
    doc.save().moveTo(M.left, 56).lineTo(PW - M.right, 56).lineWidth(0.5).strokeColor(hash(p.border)).stroke().restore();
    drawWatermark();
    doc.x = M.left;
    doc.y = M.top;
  });

  // Section heading helper.
  const sectionHeading = (text: string, sub?: string, divider = false): void => {
    ensure(divider ? 90 : 56);
    if (divider) {
      doc.moveDown(0.4);
      const y = doc.y;
      doc.save().rect(M.left, y, CW, 46).fill(hash(p.primary)).restore();
      doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(17).text(text, M.left + 14, y + 13, { width: CW - 28 });
      doc.y = y + 46;
      if (sub !== undefined) {
        doc.fillColor(hash(p.muted)).font(f.pdfItalic).fontSize(11).text(sub, M.left, doc.y + 8, { width: CW });
      }
      doc.moveDown(0.6);
      return;
    }
    doc.moveDown(0.6);
    const y = doc.y;
    doc.save().rect(M.left, y + 2, 5, 18).fill(hash(p.accent)).restore();
    doc.fillColor(hash(p.primary)).font(f.pdfHeading).fontSize(16).text(text, M.left + 14, y, { width: CW - 14 });
    if (sub !== undefined) {
      doc.fillColor(hash(p.muted)).font(f.pdfItalic).fontSize(10.5).text(sub, M.left + 14, doc.y + 1, { width: CW - 14 });
    }
    doc.save().moveTo(M.left, doc.y + 6).lineTo(PW - M.right, doc.y + 6).lineWidth(0.75).strokeColor(hash(p.border)).stroke().restore();
    doc.y += 12;
  };

  const paragraph = (text: string): void => {
    doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(11).text(text, M.left, doc.y, { width: CW, align: 'justify', lineGap: 2 });
    doc.moveDown(0.5);
  };

  const bulletList = (items: string[]): void => {
    doc.font(f.pdfBody).fontSize(11);
    for (const item of items) {
      ensure(20);
      const y = doc.y;
      doc.save().circle(M.left + 4, y + 6, 2.2).fill(hash(p.accent)).restore();
      doc.fillColor(hash(p.text)).text(item, M.left + 16, y, { width: CW - 16, lineGap: 1.5 });
      doc.moveDown(0.2);
    }
    doc.moveDown(0.4);
  };

  // KPI tiles row.
  const kpiRow = (kpis: KpiSpec[]): void => {
    const n = Math.min(kpis.length, 4);
    if (n === 0) return;
    const gap = 12;
    const cardW = (CW - gap * (n - 1)) / n;
    const cardH = 78;
    ensure(cardH + 12);
    const y = doc.y;
    for (let i = 0; i < n; i++) {
      const k = kpis[i]!;
      const x = M.left + i * (cardW + gap);
      doc.save().roundedRect(x, y, cardW, cardH, 6).fill(hash(p.surface));
      doc.rect(x, y, cardW, 4).fill(hash(p.accent)).restore();
      doc.fillColor(hash(p.primary)).font(f.pdfHeading).fontSize(22).text(k.value, x + 8, y + 14, { width: cardW - 16, align: 'center' });
      doc.fillColor(hash(p.muted)).font(f.pdfHeading).fontSize(8.5).text(k.label.toUpperCase(), x + 8, y + 44, { width: cardW - 16, align: 'center', characterSpacing: 0.5 });
      if (k.sub !== undefined) {
        doc.fillColor(hash(p.accent)).font(f.pdfBody).fontSize(9).text(k.sub, x + 8, y + 58, { width: cardW - 16, align: 'center' });
      }
    }
    doc.y = y + cardH + 12;
  };

  // Callout box.
  const calloutBox = (section: DocumentSection): void => {
    const co = section.callout!;
    const color = calloutColor(theme, co.variant);
    doc.font(f.pdfBody).fontSize(11);
    const textH = doc.heightOfString(co.text, { width: CW - 48 });
    const boxH = textH + (co.title !== undefined ? 44 : 28);
    ensure(boxH + 12);
    const y = doc.y;
    doc.save().roundedRect(M.left, y, CW, boxH, 6).fill(hash(p.surface));
    doc.rect(M.left, y, 5, boxH).fill(hash(color)).restore();
    let ty = y + 14;
    if (co.title !== undefined) {
      doc.fillColor(hash(color)).font(f.pdfHeading).fontSize(12.5).text(co.title, M.left + 18, ty, { width: CW - 36 });
      ty = doc.y + 4;
    }
    doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(11).text(co.text, M.left + 18, ty, { width: CW - 36, lineGap: 1.5 });
    doc.y = y + boxH + 12;
  };

  // Pull-quote.
  const quoteBlock = (section: DocumentSection): void => {
    const q = section.quote ?? { text: section.body ?? '' };
    doc.font(f.pdfItalic).fontSize(15);
    const textH = doc.heightOfString(q.text, { width: CW - 60 });
    ensure(textH + 50);
    const y = doc.y + 6;
    doc.save().rect(M.left, y, 5, textH + 8).fill(hash(p.accent)).restore();
    doc.fillColor(hash(p.primary)).font(f.pdfItalic).fontSize(15).text(q.text, M.left + 22, y, { width: CW - 60, lineGap: 2 });
    if (q.attribution !== undefined) {
      doc.fillColor(hash(p.muted)).font(f.pdfHeading).fontSize(11).text(`— ${q.attribution}`, M.left + 22, doc.y + 6, { width: CW - 60 });
    }
    doc.moveDown(0.6);
  };

  // Timeline.
  const timelineBlock = (items: TimelineItem[]): void => {
    doc.font(f.pdfBody);
    for (const it of items) {
      ensure(40);
      const y = doc.y;
      doc.save().circle(M.left + 50, y + 7, 4).fill(hash(p.accent)).restore();
      doc.save().moveTo(M.left + 50, y + 11).lineTo(M.left + 50, y + 40).lineWidth(1).strokeColor(hash(p.border)).stroke().restore();
      doc.fillColor(hash(p.primary)).font(f.pdfHeading).fontSize(10).text(it.date, M.left, y + 2, { width: 42, align: 'right' });
      doc.fillColor(hash(p.text)).font(f.pdfHeading).fontSize(12).text(it.title, M.left + 64, y, { width: CW - 64 });
      if (it.detail !== undefined) {
        doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(10).text(it.detail, M.left + 64, doc.y + 1, { width: CW - 64 });
      }
      doc.moveDown(0.5);
    }
    doc.moveDown(0.2);
  };

  // Two-column / comparison.
  const columnsBlock = (section: DocumentSection): void => {
    const cols = (section.columns ?? []).slice(0, 2);
    if (cols.length === 0) return;
    const comparison = section.layout === 'comparison';
    const gap = 18;
    const colW = (CW - gap) / 2;
    // Measure the taller column to size the cards equally.
    const heights = cols.map((col) => {
      let h = 14;
      if (col.heading !== undefined) h += 26;
      doc.font(f.pdfBody).fontSize(10.5);
      if (col.bullets !== undefined) for (const b of col.bullets) h += doc.heightOfString(b, { width: colW - 34 }) + 6;
      if (col.body !== undefined) h += doc.heightOfString(col.body, { width: colW - 28 }) + 6;
      return h + 12;
    });
    const cardH = Math.max(...heights);
    ensure(cardH + 12);
    const y = doc.y;
    cols.forEach((col, i) => {
      const x = M.left + i * (colW + gap);
      const head = comparison ? (i === 0 ? p.primary : p.accent) : p.primary;
      doc.save().roundedRect(x, y, colW, cardH, 6).fill(hash(p.surface)).restore();
      let cy = y + 12;
      if (col.heading !== undefined) {
        doc.save().roundedRect(x, y, colW, 26, 6).fill(hash(head)).restore();
        doc.save().rect(x, y + 13, colW, 13).fill(hash(head)).restore();
        doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(11.5).text(col.heading, x + 12, y + 7, { width: colW - 24 });
        cy = y + 34;
      }
      if (col.bullets !== undefined) {
        doc.font(f.pdfBody).fontSize(10.5);
        for (const b of col.bullets) {
          doc.save().circle(x + 14, cy + 5, 2).fill(hash(p.accent)).restore();
          doc.fillColor(hash(p.text)).text(b, x + 22, cy, { width: colW - 34 });
          cy = doc.y + 5;
        }
      } else if (col.body !== undefined) {
        doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(10.5).text(col.body, x + 14, cy, { width: colW - 28, lineGap: 1.5 });
      }
    });
    doc.y = y + cardH + 12;
  };

  // Themed table.
  const tableBlock = (table: { header: string[]; rows: string[][] }): void => {
    const cols = table.header.length;
    if (cols === 0) return;
    const colW = CW / cols;
    const rowH = 22;
    const drawHeader = (): void => {
      const y = doc.y;
      doc.save().rect(M.left, y, CW, rowH).fill(hash(p.primary)).restore();
      doc.fillColor(hash(p.white)).font(f.pdfHeading).fontSize(10);
      table.header.forEach((h, i) => doc.text(h, M.left + i * colW + 6, y + 6, { width: colW - 12, lineBreak: false, ellipsis: true }));
      doc.y = y + rowH;
    };
    ensure(rowH * 2);
    drawHeader();
    table.rows.forEach((row, ri) => {
      if (doc.y + rowH > PH - M.bottom) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      doc.save().rect(M.left, y, CW, rowH).fill(hash(ri % 2 === 0 ? p.white : p.surface)).restore();
      doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(9.5);
      row.slice(0, cols).forEach((cell, i) => doc.text(cell, M.left + i * colW + 6, y + 6, { width: colW - 12, lineBreak: false, ellipsis: true }));
      doc.y = y + rowH;
    });
    doc.save().rect(M.left, doc.y - rowH * (table.rows.length + 1), CW, rowH * (table.rows.length + 1)).lineWidth(0.5).strokeColor(hash(p.border)).stroke().restore();
    doc.moveDown(0.6);
  };

  // Native chart drawing (bar / line / pie / doughnut).
  const chartBlock = (chart: ChartSpec): void => {
    const boxH = 230;
    ensure(boxH + 16);
    const x0 = M.left;
    const y0 = doc.y + 8;
    const plotX = x0 + 36;
    const plotY = y0 + 8;
    const plotW = CW - 48;
    const plotH = boxH - 56;
    const colors = theme.palette.chartSeries;

    if (chart.title !== undefined) {
      doc.fillColor(hash(p.text)).font(f.pdfHeading).fontSize(11).text(chart.title, x0, y0 - 4, { width: CW, align: 'center' });
    }

    if (chart.type === 'pie' || chart.type === 'doughnut') {
      const vals = chart.series[0]?.values ?? [];
      const sum = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
      const cx = x0 + plotW / 3;
      const cy = plotY + plotH / 2 + 6;
      const r = Math.min(plotH, plotW / 2) / 2;
      let ang = -Math.PI / 2;
      vals.forEach((v, i) => {
        const slice = (Math.max(0, v) / sum) * Math.PI * 2;
        const steps = Math.max(2, Math.ceil((slice / (Math.PI * 2)) * 60));
        doc.save().moveTo(cx, cy);
        for (let s = 0; s <= steps; s++) {
          const a = ang + (slice * s) / steps;
          doc.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        doc.fill(hash(colors[i % colors.length]!));
        doc.restore();
        ang += slice;
      });
      if (chart.type === 'doughnut') {
        doc.save().circle(cx, cy, r * 0.55).fill(hash(p.white)).restore();
      }
      // Legend.
      const lx = x0 + (plotW / 3) * 2 + 10;
      let ly = plotY + 8;
      chart.categories.forEach((cat, i) => {
        doc.save().rect(lx, ly + 1, 9, 9).fill(hash(colors[i % colors.length]!)).restore();
        const pct = Math.round((Math.max(0, vals[i] ?? 0) / sum) * 100);
        doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(9).text(`${cat} — ${pct}%`, lx + 14, ly, { width: plotW / 3 - 20, lineBreak: false, ellipsis: true });
        ly += 16;
      });
      doc.y = y0 + boxH;
      doc.moveDown(0.4);
      return;
    }

    // Axes for bar/line.
    const allVals = chart.series.flatMap((s) => s.values);
    const maxV = Math.max(1, ...allVals);
    doc.save().moveTo(plotX, plotY).lineTo(plotX, plotY + plotH).lineTo(plotX + plotW, plotY + plotH).lineWidth(0.75).strokeColor(hash(p.border)).stroke().restore();
    // Gridlines + y labels.
    doc.font(f.pdfBody).fontSize(7.5).fillColor(hash(p.muted));
    for (let g = 0; g <= 4; g++) {
      const gy = plotY + plotH - (plotH * g) / 4;
      doc.save().moveTo(plotX, gy).lineTo(plotX + plotW, gy).lineWidth(0.4).strokeColor(hash(p.border)).opacity(0.7).stroke().restore();
      doc.fillColor(hash(p.muted)).text(String(Math.round((maxV * g) / 4)), x0 - 2, gy - 4, { width: 32, align: 'right' });
    }
    const cats = chart.categories.length;
    const slotW = plotW / Math.max(1, cats);

    if (chart.type === 'line') {
      chart.series.forEach((s, si) => {
        doc.save().lineWidth(2).strokeColor(hash(colors[si % colors.length]!));
        s.values.forEach((v, ci) => {
          const px = plotX + slotW * ci + slotW / 2;
          const py = plotY + plotH - (Math.max(0, v) / maxV) * plotH;
          if (ci === 0) doc.moveTo(px, py);
          else doc.lineTo(px, py);
        });
        doc.stroke().restore();
        s.values.forEach((v, ci) => {
          const px = plotX + slotW * ci + slotW / 2;
          const py = plotY + plotH - (Math.max(0, v) / maxV) * plotH;
          doc.save().circle(px, py, 2.5).fill(hash(colors[si % colors.length]!)).restore();
        });
      });
    } else {
      // Grouped bars.
      const series = chart.series.length;
      const groupPad = slotW * 0.2;
      const barW = (slotW - groupPad) / series;
      chart.series.forEach((s, si) => {
        s.values.forEach((v, ci) => {
          const bh = (Math.max(0, v) / maxV) * plotH;
          const bx = plotX + slotW * ci + groupPad / 2 + si * barW;
          const by = plotY + plotH - bh;
          doc.save().rect(bx, by, barW - 2, bh).fill(hash(colors[si % colors.length]!)).restore();
        });
      });
    }
    // X labels.
    doc.font(f.pdfBody).fontSize(7.5).fillColor(hash(p.muted));
    chart.categories.forEach((cat, ci) => {
      doc.text(cat, plotX + slotW * ci, plotY + plotH + 4, { width: slotW, align: 'center', lineBreak: false, ellipsis: true });
    });
    // Legend for multi-series.
    if (chart.series.length > 1) {
      let lx = plotX;
      const ly = plotY + plotH + 18;
      chart.series.forEach((s, si) => {
        doc.save().rect(lx, ly, 9, 9).fill(hash(colors[si % colors.length]!)).restore();
        doc.fillColor(hash(p.text)).font(f.pdfBody).fontSize(8).text(s.name, lx + 13, ly, { lineBreak: false });
        lx += 13 + doc.widthOfString(s.name) + 18;
      });
    }
    doc.y = y0 + boxH;
    doc.moveDown(0.4);
  };

  // ── Render sections as a flowing document (page 2 onward) ──────────────────
  doc.addPage();
  for (const section of spec.sections) {
    if (section.layout === 'cover') continue;
    if (section.layout === 'section-divider') {
      sectionHeading(section.title ?? '', section.subtitle, true);
      if (section.body !== undefined) paragraph(section.body);
      continue;
    }
    if (section.layout === 'closing') {
      sectionHeading(section.title ?? 'Conclusion', section.subtitle);
      if (section.body !== undefined) paragraph(section.body);
      if (section.bullets !== undefined) bulletList(section.bullets);
      continue;
    }
    if (section.layout === 'quote') {
      if (section.title !== undefined) sectionHeading(section.title);
      quoteBlock(section);
      continue;
    }

    if (section.title !== undefined) sectionHeading(section.title, section.subtitle);
    switch (section.layout) {
      case 'kpis':
        if (section.kpis !== undefined) kpiRow(section.kpis);
        if (section.body !== undefined) paragraph(section.body);
        if (section.bullets !== undefined) bulletList(section.bullets);
        break;
      case 'chart':
        if (section.body !== undefined) paragraph(section.body);
        if (section.chart !== undefined) chartBlock(section.chart);
        break;
      case 'table':
        if (section.body !== undefined) paragraph(section.body);
        if (section.bullets !== undefined) bulletList(section.bullets);
        if (section.table !== undefined) tableBlock(section.table);
        break;
      case 'timeline':
        if (section.body !== undefined) paragraph(section.body);
        if (section.timeline !== undefined) timelineBlock(section.timeline);
        break;
      case 'two-column':
      case 'comparison':
        if (section.body !== undefined) paragraph(section.body);
        columnsBlock(section);
        break;
      case 'callout':
        if (section.body !== undefined) paragraph(section.body);
        calloutBox(section);
        break;
      case 'paragraph':
        if (section.body !== undefined) paragraph(section.body);
        if (section.bullets !== undefined) bulletList(section.bullets);
        break;
      default:
        if (section.body !== undefined) paragraph(section.body);
        if (section.bullets !== undefined) bulletList(section.bullets);
        if (section.callout !== undefined) calloutBox(section);
        break;
    }
  }

  // ── Footers on every content page (skip the cover) ─────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PH - 44;
    doc.save().moveTo(M.left, fy).lineTo(PW - M.right, fy).lineWidth(0.5).strokeColor(hash(p.border)).stroke().restore();
    if (org.length > 0) {
      doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(8.5).text(spec.brand?.footer ?? org, M.left, fy + 6, { width: CW * 0.7, lineBreak: false, ellipsis: true });
    }
    doc.fillColor(hash(p.muted)).font(f.pdfBody).fontSize(8.5).text(`Page ${i - range.start} of ${range.count - 1}`, M.left + CW * 0.7, fy + 6, { width: CW * 0.3, align: 'right' });
  }

  doc.end();
  return done;
}

/* ── DOCX (docx) ──────────────────────────────────────────────────────────── */

/** Render a structured {@link DocumentSpec} into a themed Word document. */
async function renderDocxFromSpec(spec: DocumentSpec, theme: Theme): Promise<Buffer> {
  const docx = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    AlignmentType, BorderStyle, ShadingType, PageBreak,
  } = docx;
  const p = theme.palette;
  const org = spec.brand?.organization ?? spec.author ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [];

  // ── Cover ──────────────────────────────────────────────────────────────────
  children.push(
    new Paragraph({ spacing: { before: 2200 } }),
    new Paragraph({
      shading: { type: ShadingType.SOLID, color: p.accent, fill: p.accent },
      spacing: { after: 60 },
      children: [new TextRun({ text: '', size: 8 })],
      border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: p.accent } },
    }),
    new Paragraph({
      spacing: { before: 240, after: 120 },
      children: [new TextRun({ text: spec.title, bold: true, size: 64, color: p.primary, font: 'Calibri' })],
    }),
  );
  if (spec.subtitle !== undefined) {
    children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: spec.subtitle, size: 30, color: p.muted, font: 'Calibri' })] }));
  }
  if (org.length > 0) {
    children.push(new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: org, bold: true, size: 24, color: p.text })] }));
  }
  if (spec.date !== undefined) {
    children.push(new Paragraph({ children: [new TextRun({ text: spec.date, size: 22, color: p.muted })] }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const heading = (text: string, divider = false): any =>
    new Paragraph({
      spacing: { before: divider ? 240 : 320, after: 140 },
      ...(divider
        ? { shading: { type: ShadingType.SOLID, color: p.primary, fill: p.primary } }
        : { border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: p.border } } }),
      children: [new TextRun({ text, bold: true, size: divider ? 30 : 28, color: divider ? p.white : p.primary, font: 'Calibri' })],
    });

  const subHeading = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, italics: true, size: 22, color: p.muted })] });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const themedTable = (header: string[], rows: string[][]): any => {
    const headRow = new TableRow({
      tableHeader: true,
      children: header.map(
        (h) =>
          new TableCell({
            shading: { type: ShadingType.SOLID, color: p.primary, fill: p.primary },
            margins: { top: 60, bottom: 60, left: 80, right: 80 },
            children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: p.white, size: 20 })] })],
          }),
      ),
    });
    const bodyRows = rows.map(
      (row, ri) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                shading: { type: ShadingType.SOLID, color: ri % 2 === 0 ? p.white : p.surface, fill: ri % 2 === 0 ? p.white : p.surface },
                margins: { top: 50, bottom: 50, left: 80, right: 80 },
                children: [new Paragraph({ children: [new TextRun({ text: cell, size: 19, color: p.text })] })],
              }),
          ),
        }),
    );
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: p.border },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: p.border },
        left: { style: BorderStyle.SINGLE, size: 2, color: p.border },
        right: { style: BorderStyle.SINGLE, size: 2, color: p.border },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: p.border },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: p.border },
      },
      rows: [headRow, ...bodyRows],
    });
  };

  for (const section of spec.sections) {
    if (section.layout === 'cover') continue;

    if (section.layout === 'section-divider') {
      children.push(heading(section.title ?? '', true));
      if (section.subtitle !== undefined) children.push(subHeading(section.subtitle));
      if (section.body !== undefined) children.push(new Paragraph({ spacing: { after: 160 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: section.body, size: 22, color: p.text })] }));
      continue;
    }

    if (section.title !== undefined) children.push(heading(section.title));
    if (section.subtitle !== undefined) children.push(subHeading(section.subtitle));

    if (section.body !== undefined) {
      children.push(new Paragraph({ spacing: { after: 160 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: section.body, size: 22, color: p.text })] }));
    }
    if (section.quote !== undefined) {
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 80 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 24, color: p.accent, space: 12 } },
          children: [new TextRun({ text: section.quote.text, italics: true, size: 26, color: p.primary })],
        }),
      );
      if (section.quote.attribution !== undefined) {
        children.push(new Paragraph({ indent: { left: 360 }, spacing: { after: 160 }, children: [new TextRun({ text: `— ${section.quote.attribution}`, bold: true, size: 20, color: p.muted })] }));
      }
    }
    if (section.bullets !== undefined) {
      for (const b of section.bullets) {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text: b, size: 22, color: p.text })] }));
      }
      children.push(new Paragraph({ spacing: { after: 80 } }));
    }
    if (section.kpis !== undefined && section.kpis.length > 0) {
      const cells = section.kpis.slice(0, 4).map(
        (k) =>
          new TableCell({
            shading: { type: ShadingType.SOLID, color: p.surface, fill: p.surface },
            margins: { top: 120, bottom: 120, left: 80, right: 80 },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: k.value, bold: true, size: 40, color: p.primary })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: k.label.toUpperCase(), size: 16, color: p.muted })] }),
              ...(k.sub !== undefined ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: k.sub, size: 18, color: p.accent, bold: true })] })] : []),
            ],
          }),
      );
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: cells })] }));
      children.push(new Paragraph({ spacing: { after: 160 } }));
    }
    if (section.columns !== undefined && section.columns.length > 0) {
      const cols = section.columns.slice(0, 2);
      const comparison = section.layout === 'comparison';
      const cells = cols.map((col, i) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inner: any[] = [];
        if (col.heading !== undefined) {
          inner.push(new Paragraph({ shading: { type: ShadingType.SOLID, color: comparison && i === 1 ? p.accent : p.primary, fill: comparison && i === 1 ? p.accent : p.primary }, spacing: { after: 80 }, children: [new TextRun({ text: col.heading, bold: true, color: p.white, size: 22 })] }));
        }
        if (col.bullets !== undefined) for (const b of col.bullets) inner.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b, size: 20, color: p.text })] }));
        if (col.body !== undefined) inner.push(new Paragraph({ children: [new TextRun({ text: col.body, size: 20, color: p.text })] }));
        return new TableCell({ shading: { type: ShadingType.SOLID, color: p.surface, fill: p.surface }, margins: { top: 100, bottom: 100, left: 120, right: 120 }, children: inner });
      });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: cells })] }));
      children.push(new Paragraph({ spacing: { after: 160 } }));
    }
    if (section.timeline !== undefined) {
      for (const it of section.timeline) {
        children.push(new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: `${it.date}  `, bold: true, size: 20, color: p.accent }), new TextRun({ text: it.title, bold: true, size: 22, color: p.text })] }));
        if (it.detail !== undefined) children.push(new Paragraph({ indent: { left: 360 }, spacing: { after: 60 }, children: [new TextRun({ text: it.detail, size: 20, color: p.muted })] }));
      }
      children.push(new Paragraph({ spacing: { after: 120 } }));
    }
    if (section.table !== undefined) {
      children.push(themedTable(section.table.header, section.table.rows));
      children.push(new Paragraph({ spacing: { after: 160 } }));
    }
    if (section.chart !== undefined) {
      // Word charts are complex; render the data as a clean themed table with a caption.
      const ch = section.chart;
      const header = ['', ...ch.series.map((s) => s.name)];
      const rows = ch.categories.map((cat, ci) => [cat, ...ch.series.map((s) => String(s.values[ci] ?? ''))]);
      children.push(themedTable(header, rows));
      children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: `Figure: ${ch.title ?? section.title ?? 'Data'}`, italics: true, size: 18, color: p.muted })] }));
    }
    if (section.callout !== undefined) {
      const color = calloutColor(theme, section.callout.variant);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner: any[] = [];
      if (section.callout.title !== undefined) inner.push(new Paragraph({ children: [new TextRun({ text: section.callout.title, bold: true, size: 22, color })] }));
      inner.push(new Paragraph({ children: [new TextRun({ text: section.callout.text, size: 21, color: p.text })] }));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { left: { style: BorderStyle.SINGLE, size: 24, color }, top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
          rows: [new TableRow({ children: [new TableCell({ shading: { type: ShadingType.SOLID, color: p.surface, fill: p.surface }, margins: { top: 120, bottom: 120, left: 160, right: 120 }, children: inner })] })],
        }),
      );
      children.push(new Paragraph({ spacing: { after: 160 } }));
    }
  }

  const buffer = await Packer.toBuffer(
    new Document({
      creator: org.length > 0 ? org : 'Auxify',
      title: spec.title,
      sections: [{ properties: { page: { margin: { top: 1100, bottom: 1100, left: 1100, right: 1100 } } }, children }],
    }),
  );
  return Buffer.from(buffer);
}


