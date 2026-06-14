/**
 * Artifact extraction — the "responses in different files" capability.
 *
 * When the assistant does research or a build task, we ask it (via a system
 * primer) to emit each deliverable as a fenced code block tagged with a
 * filename. This module parses an assistant message back into a list of named
 * {@link Artifact} files so the UI can show them in a side panel and let the
 * user view, download individually, or download the whole set.
 *
 * Recognized filename forms on a fence:
 *   ```ts file=src/index.ts        (info-string `file=` / `title=` / `name=`)
 *   ```python path/to/script.py    (a bare path after the language)
 * or as the block's first line:
 *   // file: src/index.ts
 *   # file: app/main.py
 */

/** A single generated file extracted from an assistant response. */
export interface Artifact {
  /** The file name / path (e.g. `src/App.tsx`). */
  filename: string;
  /** The fence language (e.g. `tsx`), best-effort. */
  language: string;
  /** The file contents. */
  content: string;
}

/** Extension → MIME for downloads (text-first; everything else is plain text). */
const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  xml: 'application/xml',
};

/** Best-effort MIME type for a filename. */
export function mimeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'text/plain';
}

/** A fence info string like "ts file=src/a.ts" → language + optional filename. */
function parseInfoString(info: string): { language: string; filename?: string } {
  const trimmed = info.trim();
  if (trimmed.length === 0) return { language: '' };

  const tokens = trimmed.split(/\s+/);
  const language = tokens[0] ?? '';

  // key=value form (file=, title=, name=, path=)
  const kv = trimmed.match(/(?:file|title|name|path)\s*=\s*["']?([^"'\s]+)["']?/i);
  if (kv?.[1]) {
    return { language, filename: kv[1] };
  }
  // bare second token that looks like a path/filename (contains . or /)
  const second = tokens[1];
  if (second && /[./]/.test(second)) {
    return { language, filename: second.replace(/^["']|["']$/g, '') };
  }
  return { language };
}

/** A first-line comment like `// file: a.ts` or `# file: a.py` → filename. */
function filenameFromFirstLine(body: string): { filename?: string; rest: string } {
  const nl = body.indexOf('\n');
  const firstLine = (nl === -1 ? body : body.slice(0, nl)).trim();
  const m = firstLine.match(/^(?:\/\/|#|<!--)\s*(?:file|filename|path)\s*:\s*(.+?)\s*(?:-->)?$/i);
  if (m?.[1]) {
    return { filename: m[1].trim(), rest: nl === -1 ? '' : body.slice(nl + 1) };
  }
  return { rest: body };
}

/** A safe default extension for a language when no filename was given. */
const DEFAULT_EXT: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx',
  python: 'py', py: 'py', bash: 'sh', sh: 'sh', json: 'json', yaml: 'yml', yml: 'yml',
  html: 'html', css: 'css', sql: 'sql', markdown: 'md', md: 'md', go: 'go', rust: 'rs',
  java: 'java', csv: 'csv',
};

/**
 * Extract every named file from a single assistant message. A code block is
 * promoted to an {@link Artifact} only when a filename can be determined (from
 * the info string or a first-line `file:` comment) — prose code samples without
 * a name are left inline and ignored here.
 */
export function extractArtifacts(markdown: string): Artifact[] {
  const artifacts: Artifact[] = [];
  // Match fenced blocks: ```info\n...body...\n```
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let autoIndex = 0;

  while ((match = fence.exec(markdown)) !== null) {
    const info = match[1] ?? '';
    const rawBody = match[2] ?? '';
    const { language, filename: infoName } = parseInfoString(info);
    const { filename: lineName, rest } = filenameFromFirstLine(rawBody);

    const filename = infoName ?? lineName;
    if (filename === undefined) {
      continue; // unnamed sample — not a deliverable file
    }
    const content = (infoName ? rawBody : rest).replace(/\s+$/, '') + '\n';
    artifacts.push({ filename, language: language || guessLang(filename), content });
    autoIndex += 1;
  }
  void autoIndex;
  return dedupeByFilename(artifacts);
}

/** Guess a fence language from a filename extension. */
function guessLang(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const entry = Object.entries(DEFAULT_EXT).find(([, e]) => e === ext);
  return entry?.[0] ?? ext;
}

/** Later files with the same name win (the model may revise a file). */
function dedupeByFilename(list: Artifact[]): Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const a of list) byName.set(a.filename, a);
  return [...byName.values()];
}

/** The system primer that asks the model to emit multi-file deliverables. */
export const ARTIFACTS_PRIMER =
  'When the user asks you to build, generate, or research something that ' +
  'results in one or more files, output EACH file as its own fenced code ' +
  'block tagged with its filename using the form ```language file=path/name.ext ' +
  'so the files can be saved individually. Keep explanation outside the code ' +
  'blocks. Use real, sensible file paths.';

/**
 * The system primer that makes models "draw" instead of refusing. Text-only
 * models can't emit raster images, but the chat UI renders any ```svg / ```html
 * block they produce as a real, visible picture (see {@link VisualArtifact}),
 * so we tell the model to draw with vector markup rather than apologize.
 */
export const VISUAL_PRIMER =
  'You CAN produce pictures, diagrams, logos, and charts even without an image ' +
  'generator: output a complete, self-contained SVG inside a ```svg code block ' +
  '(or a small self-contained HTML/CSS scene inside a ```html block). The chat ' +
  'renders that markup as a visible image automatically. So never reply that ' +
  'you cannot create images — instead draw it with detailed, real SVG markup ' +
  '(shapes, paths, colors, gradients) and keep any explanation outside the block.';
