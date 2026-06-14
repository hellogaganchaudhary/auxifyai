'use client';

/**
 * Renders assistant content as polished, formatted markdown (GFM) instead of
 * raw text — headings, lists, tables, code blocks, links, blockquotes — styled
 * by the `.cg__md` rules in globals.css to match the Auxify brand.
 *
 * Two premium touches:
 *   - Fenced code blocks are upgraded to {@link CodeBlock} (language label +
 *     one-click Copy / Download-as-file).
 *   - Inline `[n]` citations are turned into clickable superscript chips that
 *     link to their web-search source, when `sources` is supplied.
 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CodeBlock } from './CodeBlock';

/** URL schemes a rendered link/image may use (anything else is dropped). */
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Allow only http(s)/mailto/tel/anchor/relative URLs in model-authored
 * markdown. Model output is attacker-influenceable (e.g. via prompt injection
 * from scraped pages), so `javascript:`/`data:` links must never render.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return '';
  if (SAFE_URL.test(trimmed)) return trimmed;
  if (!HAS_SCHEME.test(trimmed)) return trimmed; // scheme-less relative path
  return '';
}

/** A citable source (index → resolvable URL). */
export interface CitationSource {
  index: number;
  url: string;
  title?: string;
}

/** Pull the raw text out of a code element's children. */
function nodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return nodeText((children as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

/** Replace `[n]` tokens in a plain string with clickable citation chips. */
function chipsForString(text: string, map: Map<number, CitationSource>, keyBase: string): ReactNode {
  const re = /\[(\d{1,3})\]/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const n = Number.parseInt(m[1]!, 10);
    const src = map.get(n);
    if (src !== undefined) {
      out.push(
        <a
          key={`${keyBase}-${i}`}
          href={safeUrl(src.url)}
          target="_blank"
          rel="noreferrer noopener"
          className="cg__cite"
          title={src.title ?? src.url}
        >
          {n}
        </a>,
      );
    } else {
      out.push(
        <span key={`${keyBase}-${i}`} className="cg__cite cg__cite--plain">
          {n}
        </span>,
      );
    }
    last = re.lastIndex;
    i += 1;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Recursively turn `[n]` citations inside children into chips (strings only). */
function withCitations(children: ReactNode, map: Map<number, CitationSource>, keyBase = 'c'): ReactNode {
  if (map.size === 0) return children;
  if (typeof children === 'string') return chipsForString(children, map, keyBase);
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <Fragment key={`${keyBase}-${i}`}>{withCitations(child, map, `${keyBase}-${i}`)}</Fragment>
    ));
  }
  return children;
}

/** Render a markdown string into branded, formatted HTML with citation chips. */
export function Markdown({ children, sources }: { children: string; sources?: CitationSource[] }) {
  const citeMap = new Map<number, CitationSource>((sources ?? []).map((s) => [s.index, s]));
  const cite = (nodes: ReactNode): ReactNode => withCitations(nodes, citeMap);

  return (
    <div className="cg__md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          // Open links in a new tab safely (scheme already allowlisted above).
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
          // Turn `[n]` citations inside text blocks into clickable chips.
          p: ({ children: c }) => <p>{cite(c)}</p>,
          li: ({ children: c }) => <li>{cite(c)}</li>,
          td: ({ children: c }) => <td>{cite(c)}</td>,
          // Upgrade fenced code blocks (but not inline code) to CodeBlock.
          code({ className, children: codeChildren, ...props }: ComponentPropsWithoutRef<'code'>) {
            const match = /language-(\w+)/.exec(className ?? '');
            const text = nodeText(codeChildren).replace(/\n$/, '');
            // A fenced block has a language class or contains a newline.
            if (match || text.includes('\n')) {
              return <CodeBlock language={match?.[1] ?? ''} code={text} />;
            }
            return (
              <code className={className} {...props}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
