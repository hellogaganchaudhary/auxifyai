'use client';

/**
 * `useLayout` — observe the current responsive {@link Layout} of the shell
 * (Requirement 41.1, 41.2).
 *
 * Subscribes to `matchMedia` queries that mirror the breakpoints in
 * `@/lib/responsive` (and `globals.css`) and returns the active layout mode.
 * The pure breakpoint resolution lives in `@/lib/responsive`; this hook owns
 * only the browser subscription. It defaults to `desktop` during server
 * rendering and the first client paint (matching the always-present desktop
 * grid) so hydration stays stable, then corrects to the real layout on mount.
 */
import { useEffect, useState } from 'react';
import {
  MOBILE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
  layoutForWidth,
  type Layout,
} from '@/lib/responsive';

/** Compute the current layout from `window.innerWidth`, guarding SSR. */
function readLayout(): Layout {
  if (typeof window === 'undefined') {
    return 'desktop';
  }
  return layoutForWidth(window.innerWidth);
}

/**
 * React hook returning the live {@link Layout} mode.
 *
 * @returns The current layout (`mobile` | `tablet` | `desktop`).
 */
export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>('desktop');

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    // Two media queries partition the width axis into the three layout modes.
    const mobile = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    const tablet = window.matchMedia(`(max-width: ${TABLET_MAX_WIDTH}px)`);

    const update = () => setLayout(readLayout());
    update();

    mobile.addEventListener('change', update);
    tablet.addEventListener('change', update);
    return () => {
      mobile.removeEventListener('change', update);
      tablet.removeEventListener('change', update);
    };
  }, []);

  return layout;
}
