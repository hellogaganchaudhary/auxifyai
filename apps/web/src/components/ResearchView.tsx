'use client';

/**
 * The premium Deep Research view.
 *
 * Renders the live research process — a phase timeline, discovered source
 * cards, an animated progress bar, and rolling stats — above the streaming,
 * polished Markdown report. It turns the raw status text into an aesthetic,
 * "agent at work" experience for both standard and very-deep (exhaustive) runs.
 */

import { useState } from 'react';

import type { ResearchState } from '@/lib/conversations';
import { Markdown } from './Markdown';

/** The ordered phases shown in the stepper. */
const PHASE_STEPS: { keys: string[]; label: string; icon: string }[] = [
  { keys: ['planning', 'planned'], label: 'Plan', icon: '◇' },
  { keys: ['searching', 'searched'], label: 'Search', icon: '◇' },
  { keys: ['reading', 'read'], label: 'Read', icon: '◇' },
  { keys: ['outlining', 'outlined'], label: 'Outline', icon: '◇' },
  { keys: ['writing', 'progress', 'retry', 'skipped', 'synthesizing'], label: 'Write', icon: '◇' },
];

/** Which stepper index a phase belongs to (−1 when unknown/done). */
function phaseIndex(phase: string): number {
  for (let i = 0; i < PHASE_STEPS.length; i++) {
    if (PHASE_STEPS[i]!.keys.includes(phase)) return i;
  }
  return PHASE_STEPS.length; // 'done' or unknown → past the end
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
  const d = domainOf(url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`;
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Props for the research view. */
interface ResearchViewProps {
  /** The live/finished research state. */
  research: ResearchState;
  /** The report Markdown (streamed). */
  report: string;
}

/** Render the premium deep-research process + report. */
export function ResearchView({ research, report }: ResearchViewProps) {
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [reportExpanded, setReportExpanded] = useState(false);
  const activeStep = research.running ? phaseIndex(research.phase) : PHASE_STEPS.length;
  const pct =
    research.total > 0 ? Math.min(100, Math.round((research.current / research.total) * 100)) : 0;

  const lastActivity = research.activity[research.activity.length - 1]?.message ?? '';

  return (
    <div className={`ax__rv ${research.running ? 'ax__rv--live' : 'ax__rv--done'}`}>
      {/* Header: title + live badge */}
      <div className="ax__rv-head">
        <span className="ax__rv-badge">
          <span className="ax__rv-badge-ic" aria-hidden="true">
            {research.exhaustive ? '🔬' : '🔎'}
          </span>
          {research.exhaustive ? 'Very Deep Research' : 'Deep Research'}
        </span>
        {research.running ? (
          <span className="ax__rv-live-dot">
            <span className="ax__rv-pulse" aria-hidden="true" /> Working…
          </span>
        ) : research.error ? (
          <span className="ax__rv-state ax__rv-state--err">Stopped</span>
        ) : (
          <span className="ax__rv-state ax__rv-state--ok">✓ Complete</span>
        )}
      </div>

      {/* Phase stepper */}
      <div className="ax__rv-steps" role="list">
        {PHASE_STEPS.map((step, i) => {
          const state = i < activeStep ? 'done' : i === activeStep ? 'active' : 'todo';
          return (
            <div key={step.label} className={`ax__rv-step ax__rv-step--${state}`} role="listitem">
              <span className="ax__rv-step-dot" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'active' ? '●' : '○'}
              </span>
              <span className="ax__rv-step-label">{step.label}</span>
            </div>
          );
        })}
      </div>

      {/* Live status line */}
      {research.running ? <div className="ax__rv-status">{lastActivity}</div> : null}

      {/* Progress bar + stats (writing phase) */}
      {(research.total > 0 && (research.running || research.chars > 0)) ? (
        <>
          {research.outline.length > 0 ? (
            <div className="ax__rv-bar">
              <div className="ax__rv-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <div className="ax__rv-stats">
            {research.outline.length > 0 ? (
              <span className="ax__rv-stat">
                <strong>{research.current}</strong>/{research.total} sections
              </span>
            ) : null}
            {research.words > 0 ? (
              <span className="ax__rv-stat">
                <strong>{formatInt(research.words)}</strong> words
              </span>
            ) : null}
            {research.chars > 0 ? (
              <span className="ax__rv-stat">
                <strong>{formatInt(research.chars)}</strong> chars
              </span>
            ) : null}
            {research.sources.length > 0 ? (
              <span className="ax__rv-stat">
                <strong>{research.sources.length}</strong> sources
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {/* Source cards */}
      {research.sources.length > 0 ? (
        <div className="ax__rv-sources">
          <button
            type="button"
            className="ax__rv-sources-head"
            onClick={() => setSourcesOpen((v) => !v)}
            aria-expanded={sourcesOpen}
          >
            <span>🌐 {research.sources.length} sources</span>
            <span aria-hidden="true">{sourcesOpen ? '▾' : '▸'}</span>
          </button>
          {sourcesOpen ? (
            <div className="ax__rv-source-grid">
              {research.sources.map((s) => (
                <a
                  key={s.index}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ax__rv-source"
                  title={s.title}
                >
                  <span className="ax__rv-source-n">{s.index}</span>
                  <img className="ax__rv-source-fav" src={faviconOf(s.url)} alt="" width={16} height={16} />
                  <span className="ax__rv-source-main">
                    <span className="ax__rv-source-title">{s.title}</span>
                    <span className="ax__rv-source-domain">{domainOf(s.url)}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Error notice */}
      {research.error ? (
        <div className="ax__rv-error" role="status">
          ⚠️ {research.error}
        </div>
      ) : null}

      {/* The report itself — collapsed by default when done, expandable */}
      {report.trim().length > 0 ? (
        <div className={`ax__rv-report ${!research.running && !reportExpanded ? 'ax__rv-report--collapsed' : ''}`}>
          <Markdown>{report}</Markdown>
          {research.running ? <span className="ax__rv-caret" aria-hidden="true" /> : null}
          {!research.running && !reportExpanded ? (
            <div className="ax__rv-fade" aria-hidden="true" />
          ) : null}
        </div>
      ) : research.running ? (
        <div className="ax__rv-skeleton" aria-hidden="true">
          <span /> <span /> <span />
        </div>
      ) : null}
      {!research.running && report.trim().length > 0 ? (
        <button
          type="button"
          className="ax__rv-expand"
          onClick={() => setReportExpanded((v) => !v)}
        >
          {reportExpanded ? '▴ Show Less' : '▾ Read More'}
        </button>
      ) : null}
    </div>
  );
}
