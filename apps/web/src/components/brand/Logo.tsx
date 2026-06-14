'use client';

import { useId } from 'react';

/**
 * Auxify brand mark — a fully background-free (transparent) inline SVG.
 *
 * Using an SVG instead of a raster PNG means the logo is crisp at any size,
 * has a genuinely transparent background (no white box), and can adapt to the
 * theme. The mark is an abstract "A / spark" built from a gradient stroke; the
 * lockup pairs it with the Auxify wordmark.
 */

/** Props shared by the brand components. */
interface BrandProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Optional className passthrough. */
  className?: string;
}

/** The standalone Auxify mark (transparent background). */
export function BrandMark({ size = 32, className }: BrandProps) {
  // `useId` yields a stable id across SSR and client hydration (and is unique
  // per instance), so multiple marks on a page don't collide and the server
  // and client markup match.
  const id = `ax-grad-${useId()}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Auxify"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5B8DEF" />
          <stop offset="0.5" stopColor="#2F6BFF" />
          <stop offset="1" stopColor="#7C5CFC" />
        </linearGradient>
      </defs>
      {/* Soft rounded container ring (uses the gradient stroke, transparent fill). */}
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        rx="13"
        stroke={`url(#${id})`}
        strokeWidth="2.5"
        opacity="0.35"
      />
      {/* The "A" / spark formed by two ascending strokes + a crossbar. */}
      <path
        d="M16 34 L24 13 L32 34"
        stroke={`url(#${id})`}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M19.5 27 H28.5" stroke={`url(#${id})`} strokeWidth="3.4" strokeLinecap="round" />
      {/* Accent spark dot. */}
      <circle cx="35.5" cy="13.5" r="3" fill={`url(#${id})`} />
    </svg>
  );
}

/** The full Auxify lockup: mark + wordmark, on a transparent background. */
export function BrandLockup({ size = 30, className }: BrandProps) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}
    >
      <BrandMark size={size} />
      <span className="ax__wordmark">Auxify</span>
    </span>
  );
}
