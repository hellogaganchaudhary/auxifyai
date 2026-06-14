import { describe, expect, it } from 'vitest';

import { extractVisualArtifacts, sanitizeMarkup } from './artifact-render';

describe('sanitizeMarkup', () => {
  it('strips <script> blocks', () => {
    const out = sanitizeMarkup('<svg><script>alert(1)</script><rect/></svg>');
    expect(out).not.toContain('<script');
    expect(out).toContain('<rect');
  });

  it('strips inline on* event handlers', () => {
    const out = sanitizeMarkup('<svg onload="steal()" onclick=\'x()\'><rect onmouseover=y /></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onmouseover/i);
  });

  it('neutralizes javascript: URLs', () => {
    const out = sanitizeMarkup('<svg><a href="javascript:evil()"><rect/></a></svg>');
    expect(out).not.toMatch(/javascript:/i);
  });
});

describe('extractVisualArtifacts', () => {
  it('extracts a fenced ```svg block as an svg artifact with a data URI', () => {
    const text = 'Here you go:\n\n```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```\n';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('svg');
    expect(artifacts[0]?.mimeType).toBe('image/svg+xml');
    expect(artifacts[0]?.dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('handles a fence info-string with extra tokens (```svg file=doraemon.svg)', () => {
    const text = '```svg file=doraemon.svg\n<svg><circle r="5"/></svg>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('svg');
  });

  it('treats an xml/empty fence containing <svg> as an svg artifact', () => {
    const text = '```\n<svg><path d="M0 0"/></svg>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('svg');
  });

  it('extracts a fenced ```html block as an html artifact', () => {
    const text = '```html\n<div style="color:red">hi</div>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('html');
    expect(artifacts[0]?.mimeType).toBe('text/html');
  });

  it('extracts a bare <svg> document outside any fence', () => {
    const text = 'Look: <svg><rect width="2" height="2"/></svg> done.';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('svg');
  });

  it('does not double-count an svg that is both fenced and matches the bare scan', () => {
    const text = '```svg\n<svg><rect/></svg>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts).toHaveLength(1);
  });

  it('derives a title from an SVG <title> element', () => {
    const text = '```svg\n<svg><title>Doraemon</title><circle r="5"/></svg>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts[0]?.title).toBe('Doraemon');
  });

  it('returns nothing for plain prose or non-visual code', () => {
    expect(extractVisualArtifacts('just some text')).toHaveLength(0);
    expect(extractVisualArtifacts('```ts\nconst x = 1;\n```')).toHaveLength(0);
  });

  it('sanitizes the captured source (no script survives extraction)', () => {
    const text = '```svg\n<svg><script>alert(1)</script><rect/></svg>\n```';
    const artifacts = extractVisualArtifacts(text);
    expect(artifacts[0]?.source).not.toContain('<script');
  });
});
