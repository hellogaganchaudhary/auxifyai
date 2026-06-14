'use client';

/**
 * A premium "Sources" card row shown under a web-search answer.
 *
 * Each source renders as a compact card with a favicon, title, and domain,
 * numbered to match the inline `[n]` citation chips in the answer. Clicking a
 * card opens the source in a new tab. This is the enterprise-grade equivalent
 * of the plain "Sources: NPR [1], CBS [2]" footnote line.
 */

interface Source {
  index: number;
  title: string;
  url: string;
}

/** Best-effort domain for a URL. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A favicon URL for a domain (Google's public favicon service). */
function faviconOf(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainOf(url))}&sz=64`;
}

/** Render the premium source cards for a web-search answer. */
export function SourceCards({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="ax__srcs">
      <div className="ax__srcs-head">
        <span className="ax__srcs-ic" aria-hidden="true">
          🌐
        </span>
        Sources
        <span className="ax__srcs-count">{sources.length}</span>
      </div>
      <div className="ax__srcs-grid">
        {sources.map((s) => (
          <a
            key={s.index}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ax__srcs-card"
            title={s.title}
          >
            <span className="ax__srcs-n">{s.index}</span>
            <img className="ax__srcs-fav" src={faviconOf(s.url)} alt="" width={16} height={16} />
            <span className="ax__srcs-main">
              <span className="ax__srcs-title">{s.title}</span>
              <span className="ax__srcs-domain">{domainOf(s.url)}</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
