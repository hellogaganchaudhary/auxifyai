/**
 * DOM-free unit tests for the pure theme helpers (`@/lib/theme`).
 *
 * These cover preference validation, resolution against the OS preference, and
 * the toggle cycle. They never touch the DOM so they run under the root
 * Vitest `node` environment.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  isThemePreference,
  nextThemePreference,
  resolveTheme,
  themeLabel,
} from './theme';

describe('isThemePreference', () => {
  it('accepts the three valid preferences', () => {
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
  });

  it('rejects unknown or non-string values', () => {
    expect(isThemePreference('blue')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
    expect(isThemePreference(42)).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('maps explicit preferences directly regardless of system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('follows the OS preference for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('nextThemePreference', () => {
  it('cycles light -> dark -> system -> light', () => {
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('system')).toBe('light');
  });

  it('returns a valid preference for every starting point', () => {
    for (const preference of THEME_PREFERENCES) {
      expect(THEME_PREFERENCES).toContain(nextThemePreference(preference));
    }
  });
});

describe('themeLabel', () => {
  it('labels every preference with a capitalized word', () => {
    expect(themeLabel('light')).toBe('Light');
    expect(themeLabel('dark')).toBe('Dark');
    expect(themeLabel('system')).toBe('System');
  });
});

describe('defaults', () => {
  it('defaults to system', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
  });
});
