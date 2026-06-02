/**
 * Unit tests for the Output_Renderer (Req 8.1-8.7).
 *
 * These exercise each block-type renderer through the public
 * {@link OutputRenderer} surface (the way the Chat_Service / web client use it):
 *   - GFM Markdown → headings, lists, links, tables, and escaping (Req 8.1),
 *   - code → detected language, escaped code, and the copy affordance (Req 8.2),
 *   - Mermaid → validated source + diagram type, invalid → raw (Req 8.3, 8.7),
 *   - LaTeX → validated source + display flag, invalid → raw (Req 8.4, 8.7),
 *   - table → structured model, numeric inference, sort, CSV export (Req 8.5),
 *   - artifact → Artifact_Editor side-panel descriptor (Req 8.6),
 *   - search_results → normalized entries,
 *   - and especially per-block failure isolation in `renderAll` (Req 8.7).
 */

import { describe, expect, it } from 'vitest';

import type { ContentBlock } from '@auxify/types';

import { OutputRenderer } from './output-renderer.js';
import type {
  ArtifactRenderedBlock,
  CodeRenderedBlock,
  LatexRenderedBlock,
  MarkdownRenderedBlock,
  MermaidRenderedBlock,
  RawRenderedBlock,
  SearchResultsRenderedBlock,
  TableRenderedBlock,
} from './types.js';

const renderer = new OutputRenderer();

function block(
  type: string,
  data: unknown,
  attribution?: ContentBlock['attribution'],
): ContentBlock {
  return { type: type as ContentBlock['type'], data, attribution };
}

describe('OutputRenderer markdown (Req 8.1)', () => {
  it('renders headings, lists, links, and tables as sanitized HTML', () => {
    const md = [
      '# Title',
      '',
      '- one',
      '- two',
      '',
      '[site](https://example.com)',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');

    const rendered = renderer.render(block('markdown', md)) as MarkdownRenderedBlock;

    expect(rendered.kind).toBe('markdown');
    expect(rendered.html).toContain('<h1>Title</h1>');
    expect(rendered.html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(rendered.html).toContain('<a href="https://example.com">site</a>');
    expect(rendered.html).toContain('<table>');
    expect(rendered.html).toContain('<th>a</th>');
    expect(rendered.html).toContain('<td>1</td>');
    expect(rendered.source).toBe(md);
  });

  it('escapes HTML and neutralizes javascript: links (output-path XSS defence)', () => {
    const rendered = renderer.render(
      block('markdown', 'Hello <script>alert(1)</script> [x](javascript:alert(1))'),
    ) as MarkdownRenderedBlock;

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    // unsafe link degrades to plain label text, no href emitted
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.html).toContain('x');
  });
});

describe('OutputRenderer code (Req 8.2)', () => {
  it('uses the declared language, escapes the code, and exposes a copy affordance', () => {
    const code = 'const x = 1 < 2 && 3 > 2;';
    const rendered = renderer.render(block('code', { code, language: 'ts' })) as CodeRenderedBlock;

    expect(rendered.kind).toBe('code');
    expect(rendered.language).toBe('typescript'); // alias normalized
    expect(rendered.code).toBe(code);
    expect(rendered.copyText).toBe(code); // copy control gets the exact raw code
    expect(rendered.copyable).toBe(true);
    expect(rendered.escapedCode).toContain('&lt;');
    expect(rendered.escapedCode).toContain('&amp;&amp;');
    expect(rendered.escapedCode).not.toContain('<2');
  });

  it('detects the language when none is declared and falls back to plaintext', () => {
    const py = renderer.render(
      block('code', 'def add(a, b):\n    return a + b'),
    ) as CodeRenderedBlock;
    expect(py.language).toBe('python');

    const plain = renderer.render(block('code', 'lorem ipsum dolor')) as CodeRenderedBlock;
    expect(plain.language).toBe('plaintext');
  });

  it('accepts a bare string payload as code', () => {
    const rendered = renderer.render(block('code', 'echo hi')) as CodeRenderedBlock;
    expect(rendered.kind).toBe('code');
    expect(rendered.copyText).toBe('echo hi');
  });
});

describe('OutputRenderer mermaid (Req 8.3)', () => {
  it('carries valid source and the detected diagram type for client rendering', () => {
    const source = 'flowchart TD\n  A --> B';
    const rendered = renderer.render(block('mermaid', source)) as MermaidRenderedBlock;

    expect(rendered.kind).toBe('mermaid');
    expect(rendered.source).toBe(source);
    expect(rendered.diagramType).toBe('flowchart');
  });

  it('falls back to raw when the definition is not a recognized diagram (Req 8.7)', () => {
    const rendered = renderer.render(block('mermaid', 'not a diagram at all')) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
    expect(rendered.sourceType).toBe('mermaid');
    expect(rendered.raw).toBe('not a diagram at all');
  });
});

describe('OutputRenderer latex (Req 8.4)', () => {
  it('carries valid latex with the display flag', () => {
    const rendered = renderer.render(
      block('latex', { latex: 'E = mc^2', display: false }),
    ) as LatexRenderedBlock;
    expect(rendered.kind).toBe('latex');
    expect(rendered.latex).toBe('E = mc^2');
    expect(rendered.display).toBe(false);
  });

  it('falls back to raw on unbalanced braces (Req 8.7)', () => {
    const rendered = renderer.render(block('latex', '\\frac{1}{2')) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
    expect(rendered.sourceType).toBe('latex');
  });
});

describe('OutputRenderer table (Req 8.5)', () => {
  it('builds a structured model with numeric inference, sort, and CSV export', () => {
    const rendered = renderer.render(
      block('table', {
        columns: ['name', 'score'],
        rows: [
          { name: 'bob', score: 2 },
          { name: 'amy', score: 10 },
        ],
        sort: { columnKey: 'score', direction: 'desc' },
      }),
    ) as TableRenderedBlock;

    expect(rendered.kind).toBe('table');
    expect(rendered.columns.map((c) => c.key)).toEqual(['name', 'score']);
    expect(rendered.columns[1]?.numeric).toBe(true);
    expect(rendered.columns[0]?.numeric).toBe(false);
    // sorted by score desc → amy(10) before bob(2)
    expect(rendered.rows).toEqual([
      ['amy', '10'],
      ['bob', '2'],
    ]);
    expect(rendered.sort).toEqual({ columnKey: 'score', direction: 'desc' });
    expect(rendered.csv).toBe('name,score\r\namy,10\r\nbob,2');
  });

  it('quotes CSV fields containing commas, quotes, and newlines', () => {
    const rendered = renderer.render(
      block('table', {
        columns: ['text'],
        rows: [['a,b'], ['say "hi"']],
      }),
    ) as TableRenderedBlock;
    expect(rendered.csv).toBe('text\r\n"a,b"\r\n"say ""hi"""');
  });

  it('accepts array rows aligned to columns', () => {
    const rendered = renderer.render(
      block('table', { columns: ['x', 'y'], rows: [[1, 2]] }),
    ) as TableRenderedBlock;
    expect(rendered.rows).toEqual([['1', '2']]);
  });

  it('falls back to raw when the payload lacks columns/rows (Req 8.7)', () => {
    const rendered = renderer.render(block('table', { foo: 'bar' })) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
    expect(rendered.sourceType).toBe('table');
  });
});

describe('OutputRenderer artifact (Req 8.6)', () => {
  it('produces an Artifact_Editor side-panel descriptor', () => {
    const rendered = renderer.render(
      block('artifact', {
        artifactId: 'a1',
        title: 'Plan',
        artifactType: 'document',
        content: '# Plan\n...',
      }),
    ) as ArtifactRenderedBlock;

    expect(rendered.kind).toBe('artifact');
    expect(rendered.target).toBe('artifact_editor');
    expect(rendered.artifactId).toBe('a1');
    expect(rendered.title).toBe('Plan');
    expect(rendered.artifactType).toBe('document');
    expect(rendered.content).toBe('# Plan\n...');
  });

  it('defaults the artifact type and falls back to raw without content (Req 8.7)', () => {
    const ok = renderer.render(block('artifact', { content: 'x' })) as ArtifactRenderedBlock;
    expect(ok.artifactType).toBe('document');

    const bad = renderer.render(block('artifact', { title: 'no content' })) as RawRenderedBlock;
    expect(bad.kind).toBe('raw');
  });
});

describe('OutputRenderer search_results', () => {
  it('normalizes result entries', () => {
    const rendered = renderer.render(
      block('search_results', {
        results: [
          { title: 'T1', url: 'https://a.test', snippet: 's1' },
          { title: 'T2', url: 'https://b.test' },
        ],
      }),
    ) as SearchResultsRenderedBlock;

    expect(rendered.kind).toBe('search_results');
    expect(rendered.items).toEqual([
      { title: 'T1', url: 'https://a.test', snippet: 's1' },
      { title: 'T2', url: 'https://b.test' },
    ]);
  });

  it('falls back to raw when an entry is missing required fields (Req 8.7)', () => {
    const rendered = renderer.render(
      block('search_results', { results: [{ title: 'no url' }] }),
    ) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
  });
});

describe('OutputRenderer attribution passthrough (Req 24.5)', () => {
  it('copies source attributions onto the rendered descriptor', () => {
    const attribution = [
      { sourceId: 's1', sourceTitle: 'Doc', location: 'p1', link: 'https://x.test' },
    ];
    const rendered = renderer.render(block('markdown', '# Hi', attribution));
    expect(rendered.attribution).toEqual(attribution);
  });
});

describe('OutputRenderer.render fallback totality (Req 8.7)', () => {
  it('never throws on an unknown block type', () => {
    const rendered = renderer.render(block('totally_unknown', { a: 1 })) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
    expect(rendered.reason).toContain('unsupported content block type');
  });

  it('never throws on a malformed block missing a type', () => {
    const rendered = renderer.render({ data: 'x' } as unknown as ContentBlock) as RawRenderedBlock;
    expect(rendered.kind).toBe('raw');
  });
});

describe('OutputRenderer.renderAll per-block isolation (Req 8.7, Property 23)', () => {
  it('renders siblings normally when one block fails', () => {
    const blocks: ContentBlock[] = [
      block('markdown', '# Heading'),
      block('mermaid', 'this is not a diagram'), // fails → raw
      block('code', { code: 'x = 1', language: 'python' }),
    ];

    const rendered = renderer.renderAll(blocks);

    expect(rendered).toHaveLength(3);
    expect(rendered[0]?.kind).toBe('markdown');
    expect(rendered[1]?.kind).toBe('raw'); // isolated failure
    expect(rendered[2]?.kind).toBe('code'); // sibling rendered normally
  });

  it('preserves order and length even when every block fails', () => {
    const blocks: ContentBlock[] = [
      block('latex', '\\frac{1}{2'),
      block('unknown', 1),
      block('table', { nope: true }),
    ];
    const rendered = renderer.renderAll(blocks);
    expect(rendered.map((b) => b.kind)).toEqual(['raw', 'raw', 'raw']);
  });

  it('returns an empty array for a non-array input', () => {
    expect(renderer.renderAll(undefined as unknown as ContentBlock[])).toEqual([]);
  });
});
