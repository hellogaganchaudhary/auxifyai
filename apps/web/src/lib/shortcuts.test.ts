/**
 * DOM-free unit tests for the pure keyboard-shortcut logic (`@/lib/shortcuts`).
 *
 * Cover key normalization, the single-key and two-key sequence matching state
 * machine, prefix handling, fallthrough when a sequence breaks, and the display
 * formatting. No DOM is touched, so these run under the root `node` env.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  formatShortcutKeys,
  normalizeKey,
  resolveKey,
  type Shortcut,
} from './shortcuts';

const SHORTCUTS: Shortcut[] = [
  { id: 'goto-chat', keys: ['g', 'c'], action: 'navigate', href: '/chat', description: 'Go to chat' },
  { id: 'goto-settings', keys: ['g', 's'], action: 'navigate', href: '/settings', description: 'Go to settings' },
  { id: 'focus-search', keys: ['/'], action: 'focus-search', description: 'Focus search' },
  { id: 'help', keys: ['?'], action: 'open-shortcuts-help', description: 'Help' },
];

describe('normalizeKey', () => {
  it('lower-cases single letters', () => {
    expect(normalizeKey('G')).toBe('g');
    expect(normalizeKey('c')).toBe('c');
  });

  it('passes named and punctuation keys through unchanged', () => {
    expect(normalizeKey('/')).toBe('/');
    expect(normalizeKey('Escape')).toBe('Escape');
    expect(normalizeKey('?')).toBe('?');
  });
});

describe('resolveKey single-key shortcuts', () => {
  it('matches a single-key shortcut immediately', () => {
    const result = resolveKey(SHORTCUTS, [], '/');
    expect(result.match.kind).toBe('matched');
    expect(result.match.shortcut?.id).toBe('focus-search');
    expect(result.pending).toEqual([]);
  });

  it('reports no match for an unmapped key', () => {
    const result = resolveKey(SHORTCUTS, [], 'z');
    expect(result.match.kind).toBe('none');
    expect(result.pending).toEqual([]);
  });
});

describe('resolveKey sequences', () => {
  it('holds the leader key as pending', () => {
    const result = resolveKey(SHORTCUTS, [], 'g');
    expect(result.match.kind).toBe('pending');
    expect(result.pending).toEqual(['g']);
  });

  it('completes a two-key sequence', () => {
    const afterG = resolveKey(SHORTCUTS, [], 'g');
    const afterC = resolveKey(SHORTCUTS, afterG.pending, 'c');
    expect(afterC.match.kind).toBe('matched');
    expect(afterC.match.shortcut?.id).toBe('goto-chat');
    expect(afterC.pending).toEqual([]);
  });

  it('restarts when the second key breaks the sequence but begins a new one', () => {
    const afterG = resolveKey(SHORTCUTS, [], 'g');
    // After `g`, pressing `/` is not `g /`; it should fall through to the
    // single-key `/` shortcut.
    const afterSlash = resolveKey(SHORTCUTS, afterG.pending, '/');
    expect(afterSlash.match.kind).toBe('matched');
    expect(afterSlash.match.shortcut?.id).toBe('focus-search');
  });

  it('clears pending when the second key matches nothing', () => {
    const afterG = resolveKey(SHORTCUTS, [], 'g');
    const afterZ = resolveKey(SHORTCUTS, afterG.pending, 'z');
    expect(afterZ.match.kind).toBe('none');
    expect(afterZ.pending).toEqual([]);
  });
});

describe('DEFAULT_SHORTCUTS registry', () => {
  it('every navigate shortcut has an href', () => {
    for (const shortcut of DEFAULT_SHORTCUTS) {
      if (shortcut.action === 'navigate') {
        expect(shortcut.href).toBeTruthy();
      }
    }
  });

  it('has unique ids', () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves the g c sequence to the chat route', () => {
    const afterG = resolveKey(DEFAULT_SHORTCUTS, [], 'g');
    const afterC = resolveKey(DEFAULT_SHORTCUTS, afterG.pending, 'c');
    expect(afterC.match.shortcut?.href).toBe('/chat');
  });
});

describe('formatShortcutKeys', () => {
  it('joins multi-key sequences with "then"', () => {
    expect(formatShortcutKeys({ id: 'x', keys: ['g', 'c'], action: 'navigate', href: '/chat', description: '' })).toBe(
      'g then c',
    );
  });

  it('renders a single key as itself', () => {
    expect(formatShortcutKeys({ id: 'y', keys: ['/'], action: 'focus-search', description: '' })).toBe('/');
  });
});
