/**
 * DOM-free unit tests for the pure responsive helpers (`@/lib/responsive`).
 *
 * Cover breakpoint resolution (Req 41.1, 41.2), the layout predicates, and the
 * collapsible-sidebar reducer's transitions. They never touch the DOM so they
 * run under the root Vitest `node` environment.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_SIDEBAR_STATE,
  MOBILE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
  layoutForWidth,
  showsMenuToggle,
  sidebarIsOverlay,
  sidebarReducer,
  usesBottomNav,
  type SidebarState,
} from './responsive';

describe('layoutForWidth', () => {
  it('classifies mobile at and below the mobile breakpoint', () => {
    expect(layoutForWidth(320)).toBe('mobile');
    expect(layoutForWidth(MOBILE_MAX_WIDTH)).toBe('mobile');
  });

  it('classifies tablet between the mobile and tablet breakpoints', () => {
    expect(layoutForWidth(MOBILE_MAX_WIDTH + 1)).toBe('tablet');
    expect(layoutForWidth(768)).toBe('tablet');
    expect(layoutForWidth(TABLET_MAX_WIDTH)).toBe('tablet');
  });

  it('classifies desktop above the tablet breakpoint', () => {
    expect(layoutForWidth(TABLET_MAX_WIDTH + 1)).toBe('desktop');
    expect(layoutForWidth(1440)).toBe('desktop');
  });
});

describe('layout predicates', () => {
  it('treats tablet and mobile sidebars as off-canvas overlays (Req 41.2)', () => {
    expect(sidebarIsOverlay('tablet')).toBe(true);
    expect(sidebarIsOverlay('mobile')).toBe(true);
    expect(sidebarIsOverlay('desktop')).toBe(false);
  });

  it('shows the menu toggle whenever the sidebar is an overlay', () => {
    expect(showsMenuToggle('tablet')).toBe(true);
    expect(showsMenuToggle('mobile')).toBe(true);
    expect(showsMenuToggle('desktop')).toBe(false);
  });

  it('marks only mobile as using bottom navigation (Req 41.1)', () => {
    expect(usesBottomNav('mobile')).toBe(true);
    expect(usesBottomNav('tablet')).toBe(false);
    expect(usesBottomNav('desktop')).toBe(false);
  });
});

describe('sidebarReducer', () => {
  it('starts closed', () => {
    expect(INITIAL_SIDEBAR_STATE).toEqual({ open: false });
  });

  it('opens, closes, and toggles', () => {
    const opened = sidebarReducer(INITIAL_SIDEBAR_STATE, { type: 'open' });
    expect(opened.open).toBe(true);
    const closed = sidebarReducer(opened, { type: 'close' });
    expect(closed.open).toBe(false);
    expect(sidebarReducer(closed, { type: 'toggle' }).open).toBe(true);
    expect(sidebarReducer(opened, { type: 'toggle' }).open).toBe(false);
  });

  it('keeps the same reference when open/close is a no-op', () => {
    const open: SidebarState = { open: true };
    expect(sidebarReducer(open, { type: 'open' })).toBe(open);
    const closed: SidebarState = { open: false };
    expect(sidebarReducer(closed, { type: 'close' })).toBe(closed);
  });

  it('force-closes the overlay when switching to the desktop layout', () => {
    const open: SidebarState = { open: true };
    expect(sidebarReducer(open, { type: 'layout-change', layout: 'desktop' }).open).toBe(false);
  });

  it('preserves the overlay state while the sidebar stays off-canvas', () => {
    const open: SidebarState = { open: true };
    expect(sidebarReducer(open, { type: 'layout-change', layout: 'tablet' })).toBe(open);
    expect(sidebarReducer(open, { type: 'layout-change', layout: 'mobile' })).toBe(open);
  });
});
