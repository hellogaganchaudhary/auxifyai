'use client';

/**
 * The live "we're making it" surface shown while an image, video, or document
 * is being generated — the same kind of in-progress feedback ChatGPT/Claude
 * show while an image renders.
 *
 * It pairs an animated synthesis graphic (a shimmering, de-pixelating tile grid
 * for image/video; a flowing page skeleton for documents) with the current
 * phase label and a progress bar, so the wait reads as deliberate craft rather
 * than a frozen spinner. Purely presentational — the parent owns the phase/pct
 * state and advances it.
 */

import { useEffect, useState } from 'react';

/** What is being produced (drives the graphic + copy). */
export type GenerationKind = 'image' | 'video' | 'file';

/** Props for {@link GenerationProgress}. */
export interface GenerationProgressProps {
  kind: GenerationKind;
  /** Current phase label, e.g. "Painting details". */
  label: string;
  /** Progress 0–100. */
  pct: number;
  /** The prompt/description being realized (shown muted under the bar). */
  prompt?: string;
}

/** A short verb for the header by kind. */
const TITLE: Record<GenerationKind, string> = {
  image: 'Generating image',
  video: 'Generating video',
  file: 'Designing document',
};

/** The animated synthesis graphic shown for image/video generation. */
function SynthCanvas() {
  // A grid of tiles that pulse on a staggered delay to read as a scene
  // resolving from noise into form.
  const tiles = Array.from({ length: 36 });
  return (
    <div className="ax__gen-canvas" aria-hidden>
      <div className="ax__gen-grid">
        {tiles.map((_, i) => (
          <span key={i} className="ax__gen-tile" style={{ animationDelay: `${(i % 12) * 90}ms` }} />
        ))}
      </div>
      <div className="ax__gen-scan" />
    </div>
  );
}

/** The animated page-skeleton graphic shown for document generation. */
function PageCanvas() {
  return (
    <div className="ax__gen-canvas ax__gen-canvas--doc" aria-hidden>
      <div className="ax__gen-page">
        <span className="ax__gen-line ax__gen-line--title" />
        <span className="ax__gen-line" />
        <span className="ax__gen-line" />
        <span className="ax__gen-line ax__gen-line--short" />
        <span className="ax__gen-block" />
        <span className="ax__gen-line" />
        <span className="ax__gen-line ax__gen-line--short" />
      </div>
      <div className="ax__gen-scan" />
    </div>
  );
}

/** Animated, phase-aware progress surface for media/document generation. */
export function GenerationProgress({ kind, label, pct, prompt }: GenerationProgressProps) {
  // Animate an ellipsis on the phase label for a sense of liveness.
  const [dots, setDots] = useState('');
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}.`)), 450);
    return () => clearInterval(id);
  }, []);

  const clamped = Math.max(0, Math.min(100, Math.round(pct)));

  return (
    <div className={`ax__gen ax__gen--${kind}`} role="status" aria-live="polite">
      {kind === 'file' ? <PageCanvas /> : <SynthCanvas />}
      <div className="ax__gen-body">
        <div className="ax__gen-head">
          <span className="ax__gen-title">{TITLE[kind]}</span>
          <span className="ax__gen-pct">{clamped}%</span>
        </div>
        <div className="ax__gen-bar">
          <span className="ax__gen-bar-fill" style={{ width: `${clamped}%` }} />
        </div>
        <div className="ax__gen-phase">
          {label}
          {dots}
        </div>
        {prompt !== undefined && prompt.length > 0 ? (
          <p className="ax__gen-prompt">{prompt}</p>
        ) : null}
      </div>
    </div>
  );
}
