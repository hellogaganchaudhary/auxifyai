'use client';

/**
 * The application shell: the primary three-region layout (Requirement 40.1)
 * with responsive behaviour for tablet and mobile (Requirement 41.1, 41.2).
 *
 * Composes the left navigation `Sidebar`, the central `MainArea` (which renders
 * the routed screen), the right `ContextPanel`, and the mobile `BottomNav`. It
 * also mounts the `ContextPanelProvider` (so screens can drive the contextual
 * panel) and the global `KeyboardShortcuts` handler/overlay (Req 40.6).
 *
 * Responsive model (mirrors the breakpoints in `globals.css` and the pure
 * helpers in `@/lib/responsive`):
 *   - desktop (> 1024px): the static three-region grid, unchanged.
 *   - tablet (<= 1024px): the sidebar collapses to an off-canvas drawer behind
 *     a header menu toggle; the context panel collapses to an overlay sheet.
 *   - mobile (<= 640px): the left sidebar is replaced by a fixed bottom
 *     navigation bar; the context panel is an overlay sheet; the main area is a
 *     single full-width column.
 *
 * The drawer's open/close logic is the pure `sidebarReducer`; this component
 * layers the browser side effects on top: focus moves to the first nav link
 * when the drawer opens and returns to the toggle when it closes, and Escape
 * closes the drawer (Req 41.4).
 */
import { useEffect, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { BottomNav } from './BottomNav';
import {
  ContextPanel,
  ContextPanelProvider,
  useContextPanel,
} from './ContextPanel';
import { KeyboardShortcuts, SEARCH_INPUT_ID } from './KeyboardShortcuts';
import { useLayout } from './useLayout';
import {
  INITIAL_SIDEBAR_STATE,
  sidebarIsOverlay,
  sidebarReducer,
} from '@/lib/responsive';

/** The DOM id of the off-canvas sidebar drawer, referenced by the menu toggle. */
const SIDEBAR_ID = 'app-sidebar';

/** Props the shell header needs to render the menu toggle and contextual toggle. */
interface ShellHeaderProps {
  /** Whether the sidebar drawer is currently open (overlay layouts). */
  sidebarOpen: boolean;
  /** Toggle the sidebar drawer open/closed. */
  onToggleSidebar: () => void;
  /** Ref to the menu toggle so focus can be returned to it when the drawer closes. */
  menuToggleRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * The shell header: a menu (hamburger) toggle for the off-canvas sidebar, a
 * global search field, and the contextual-panel toggle. The menu toggle is
 * always rendered but is CSS-hidden on desktop (where the sidebar is a
 * permanent column); on tablet/mobile it controls the drawer (Req 41.2).
 */
function ShellHeader({ sidebarOpen, onToggleSidebar, menuToggleRef }: ShellHeaderProps) {
  const router = useRouter();
  const { open, togglePanel } = useContextPanel();

  return (
    <header className="main-area__header">
      <button
        type="button"
        ref={menuToggleRef}
        className="btn btn--ghost btn--icon main-area__menu-toggle"
        onClick={onToggleSidebar}
        aria-expanded={sidebarOpen}
        aria-controls={SIDEBAR_ID}
        aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
      >
        <span aria-hidden="true">☰</span>
      </button>
      <form
        role="search"
        style={{ flex: 1, maxWidth: 480 }}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const query = String(data.get('q') ?? '').trim();
          router.push(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
        }}
      >
        <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
          Search Auxify
        </label>
        <input
          id={SEARCH_INPUT_ID}
          name="q"
          type="search"
          className="input"
          placeholder="Search everything…  (press / )"
          aria-keyshortcuts="/"
        />
      </form>
      <div className="main-area__header-spacer" />
      <button
        type="button"
        className="btn btn--ghost"
        onClick={togglePanel}
        aria-pressed={open}
        aria-label={open ? 'Hide contextual panel' : 'Show contextual panel'}
      >
        <span aria-hidden="true">⧉</span>
        <span>Context</span>
      </button>
    </header>
  );
}

/** Inner shell, rendered within the context-panel provider. */
function ShellBody({ children }: { children: ReactNode }) {
  const layout = useLayout();
  const overlay = sidebarIsOverlay(layout);
  const { open: contextOpen, closePanel } = useContextPanel();

  const [sidebar, dispatch] = useReducer(sidebarReducer, INITIAL_SIDEBAR_STATE);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const prevOpenRef = useRef<boolean>(false);
  const prevOverlayRef = useRef<boolean>(overlay);

  // Keep the drawer state consistent with the layout: switching to desktop (a
  // permanent sidebar column) force-closes the overlay drawer. Entering an
  // overlay layout also closes the contextual panel so its sheet does not cover
  // the content on first load (the desktop panel stays open by default).
  useEffect(() => {
    dispatch({ type: 'layout-change', layout });
    if (overlay && !prevOverlayRef.current) {
      closePanel();
    }
    prevOverlayRef.current = overlay;
  }, [layout, overlay, closePanel]);

  // Focus management for the off-canvas drawer (Req 41.4): when it opens, move
  // focus to the first navigation link; when it closes, return focus to the
  // menu toggle that opened it.
  useEffect(() => {
    if (!overlay) {
      prevOpenRef.current = sidebar.open;
      return;
    }
    if (sidebar.open && !prevOpenRef.current) {
      const firstLink = sidebarRef.current?.querySelector<HTMLElement>('a, button');
      firstLink?.focus();
    } else if (!sidebar.open && prevOpenRef.current) {
      menuToggleRef.current?.focus();
    }
    prevOpenRef.current = sidebar.open;
  }, [sidebar.open, overlay]);

  // Escape closes the open drawer (Req 41.4); the close effect above returns
  // focus to the toggle.
  useEffect(() => {
    if (!overlay || !sidebar.open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatch({ type: 'close' });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlay, sidebar.open]);

  const drawerOpen = overlay && sidebar.open;

  return (
    <div
      className="app-shell"
      data-layout={layout}
      data-context-open={contextOpen ? 'true' : 'false'}
      data-sidebar-open={drawerOpen ? 'true' : 'false'}
    >
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Sidebar
        ref={sidebarRef}
        id={SIDEBAR_ID}
        onNavigate={overlay ? () => dispatch({ type: 'close' }) : undefined}
      />
      {drawerOpen ? (
        <div
          className="app-shell__scrim"
          aria-hidden="true"
          onClick={() => dispatch({ type: 'close' })}
        />
      ) : null}
      <div className="main-area">
        <ShellHeader
          sidebarOpen={drawerOpen}
          onToggleSidebar={() => dispatch({ type: 'toggle' })}
          menuToggleRef={menuToggleRef}
        />
        <main id="main-content" className="main-area__content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <ContextPanel overlay={overlay} />
      <BottomNav />
      <KeyboardShortcuts />
    </div>
  );
}

/**
 * The shell wrapper used by the root layout. Provides contextual-panel state to
 * the whole tree and lays out the three regions.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ContextPanelProvider>
      <ShellBody>{children}</ShellBody>
    </ContextPanelProvider>
  );
}
