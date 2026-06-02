/**
 * Responsive layout model and pure helpers for the application shell
 * (Requirement 41.1, 41.2).
 *
 * The shell renders three layout modes driven purely by viewport width:
 *   - `desktop` — the full three-region grid (sidebar | main | context)
 *   - `tablet`  — a collapsible off-canvas sidebar behind a header toggle
 *   - `mobile`  — a single-column main area with a fixed bottom navigation bar
 *
 * The breakpoint resolution and the collapsible-sidebar state machine are kept
 * DOM-free and pure here so they can be unit-tested without a browser; the
 * `AppShell` client component owns the `matchMedia`/state side effects and the
 * actual focus management.
 */

/** The layout mode the shell is currently rendering. */
export type Layout = 'mobile' | 'tablet' | 'desktop';

/**
 * Breakpoint upper bounds (inclusive `max-width`, in CSS pixels). These mirror
 * the media queries in `globals.css` so the JS layout and the CSS layout always
 * agree.
 *
 * - viewport <= 640px            -> `mobile`
 * - 641px..1024px (<= 1024px)    -> `tablet`
 * - viewport > 1024px            -> `desktop`
 */
export const MOBILE_MAX_WIDTH = 640;
export const TABLET_MAX_WIDTH = 1024;

/**
 * Resolve a viewport width (CSS px) to its {@link Layout} mode.
 *
 * @param width The viewport width in CSS pixels.
 * @returns The layout mode for that width.
 */
export function layoutForWidth(width: number): Layout {
  if (width <= MOBILE_MAX_WIDTH) {
    return 'mobile';
  }
  if (width <= TABLET_MAX_WIDTH) {
    return 'tablet';
  }
  return 'desktop';
}

/**
 * Whether, in the given layout, the left sidebar is an off-canvas overlay
 * drawer that must be explicitly opened via the header menu toggle, rather than
 * the always-present static column used on desktop.
 *
 * The drawer is used on both tablet (Req 41.2, the collapsible sidebar) and
 * mobile, where it keeps every screen reachable alongside the bottom-navigation
 * shortcuts (Req 41.1). On desktop the sidebar is a permanent grid column.
 *
 * @param layout The current layout mode.
 * @returns `true` when the sidebar is an overlay drawer (tablet or mobile).
 */
export function sidebarIsOverlay(layout: Layout): boolean {
  return layout !== 'desktop';
}

/**
 * Whether the layout shows the header menu (hamburger) toggle that opens the
 * off-canvas sidebar drawer. Mirrors {@link sidebarIsOverlay}.
 *
 * @param layout The current layout mode.
 * @returns `true` on tablet and mobile.
 */
export function showsMenuToggle(layout: Layout): boolean {
  return sidebarIsOverlay(layout);
}

/**
 * Whether the layout uses the fixed bottom navigation bar (Req 41.1). The left
 * sidebar column is hidden on mobile and the primary destinations move to the
 * bottom bar.
 *
 * @param layout The current layout mode.
 * @returns `true` on mobile.
 */
export function usesBottomNav(layout: Layout): boolean {
  return layout === 'mobile';
}

/** The collapsible-sidebar state held by the shell. */
export interface SidebarState {
  /** Whether the off-canvas sidebar is currently open (tablet only). */
  open: boolean;
}

/** Actions that transition {@link SidebarState}. */
export type SidebarAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'toggle' }
  /**
   * The layout changed (e.g. the viewport was resized). The off-canvas overlay
   * only exists on tablet/mobile, so switching to desktop forces it closed to
   * avoid a stuck-open drawer once the sidebar becomes a permanent column.
   */
  | { type: 'layout-change'; layout: Layout };

/** The initial collapsed (closed) sidebar state. */
export const INITIAL_SIDEBAR_STATE: SidebarState = { open: false };

/**
 * Pure reducer for the collapsible-sidebar overlay (Req 41.2).
 *
 * Kept side-effect free so it is trivially unit-testable; the client component
 * layers focus management (moving focus into the sidebar on open, restoring it
 * to the toggle on close) on top of these transitions.
 *
 * @param state The current sidebar state.
 * @param action The action to apply.
 * @returns The next sidebar state.
 */
export function sidebarReducer(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case 'open':
      return state.open ? state : { open: true };
    case 'close':
      return state.open ? { open: false } : state;
    case 'toggle':
      return { open: !state.open };
    case 'layout-change':
      // The overlay drawer is meaningful only when the sidebar is off-canvas
      // (tablet/mobile); on desktop the sidebar is permanent, so close it.
      return sidebarIsOverlay(action.layout) ? state : { open: false };
    default:
      return state;
  }
}
