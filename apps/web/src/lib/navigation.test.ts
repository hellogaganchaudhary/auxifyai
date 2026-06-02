/**
 * DOM-free unit tests for the navigation registry helpers (`@/lib/navigation`).
 *
 * Verify that all twelve feature screens are present (Req 40.2), that grouping
 * preserves every item, and that active-route matching behaves for the home
 * route and nested sub-paths.
 */
import { describe, expect, it } from 'vitest';
import {
  FEATURE_NAV_ITEMS,
  groupedNavItems,
  isActiveRoute,
} from './navigation';

describe('FEATURE_NAV_ITEMS', () => {
  it('contains exactly the twelve required feature screens', () => {
    expect(FEATURE_NAV_ITEMS).toHaveLength(12);
  });

  it('includes each required route', () => {
    const hrefs = FEATURE_NAV_ITEMS.map((item) => item.href);
    for (const href of [
      '/chat',
      '/knowledge-hub',
      '/team-communication',
      '/documents',
      '/prompts',
      '/agent-builder',
      '/agent-monitor',
      '/knowledge-base',
      '/analytics',
      '/admin',
      '/settings',
      '/search',
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it('has unique ids and hrefs', () => {
    const ids = FEATURE_NAV_ITEMS.map((item) => item.id);
    const hrefs = FEATURE_NAV_ITEMS.map((item) => item.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('groupedNavItems', () => {
  it('preserves every feature item across groups', () => {
    const total = groupedNavItems().reduce((sum, section) => sum + section.items.length, 0);
    expect(total).toBe(FEATURE_NAV_ITEMS.length);
  });

  it('omits empty groups', () => {
    for (const section of groupedNavItems()) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});

describe('isActiveRoute', () => {
  it('matches home only exactly', () => {
    expect(isActiveRoute('/', '/')).toBe(true);
    expect(isActiveRoute('/', '/chat')).toBe(false);
  });

  it('matches a route and its nested sub-paths', () => {
    expect(isActiveRoute('/chat', '/chat')).toBe(true);
    expect(isActiveRoute('/chat', '/chat/123')).toBe(true);
    expect(isActiveRoute('/chat', '/chatroom')).toBe(false);
  });
});
