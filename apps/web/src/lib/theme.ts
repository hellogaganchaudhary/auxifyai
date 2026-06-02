/**
 * Theme model and pure helpers for the application shell (Requirement 40.4).
 *
 * The platform supports three theme preferences: an explicit `light` or `dark`
 * theme, plus `system`, which defers to the operating system's
 * `prefers-color-scheme`. These helpers are intentionally DOM-free and pure so
 * they can be unit-tested without a browser environment; the `ThemeProvider`
 * client component applies the resolved theme to the document and persists the
 * preference.
 */

/** A user-selectable theme preference (Req 40.4). */
export type ThemePreference = 'light' | 'dark' | 'system';

/** A concrete theme actually applied to the document. */
export type ResolvedTheme = 'light' | 'dark';

/** All selectable theme preferences, for iteration in toggles and tests. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'] as const;

/** The default preference used before any user choice is persisted (Req 40.4). */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/** The `localStorage` key under which the chosen preference is persisted. */
export const THEME_STORAGE_KEY = 'auxify.theme-preference';

/**
 * Narrow an arbitrary value to a valid {@link ThemePreference}.
 *
 * Used when reading a persisted preference from `localStorage`, where the
 * stored value is untrusted; unknown values fall back to the default.
 *
 * @param value A candidate value, typically read from storage.
 * @returns `true` when `value` is one of the supported preferences.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Resolve a {@link ThemePreference} into the concrete {@link ResolvedTheme} to
 * apply to the document.
 *
 * For `light`/`dark` the preference maps directly; for `system` the supplied
 * OS-level preference (`prefers-color-scheme: dark`) decides, defaulting to
 * `light` when the system preference is unknown.
 *
 * @param preference The selected theme preference.
 * @param systemPrefersDark Whether the OS currently prefers a dark scheme.
 * @returns The concrete theme to apply.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

/**
 * The human-readable label for a theme preference, used in the theme toggle UI.
 *
 * @param preference The preference to label.
 * @returns A short, capitalized label.
 */
export function themeLabel(preference: ThemePreference): string {
  switch (preference) {
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
    case 'system':
      return 'System';
  }
}

/**
 * Compute the next preference when cycling through the toggle (light → dark →
 * system → light). Keeps cycling logic in one pure, testable place.
 *
 * @param current The current preference.
 * @returns The next preference in the cycle.
 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current);
  const nextIndex = (index + 1) % THEME_PREFERENCES.length;
  // `THEME_PREFERENCES` is non-empty, so this index is always defined.
  return THEME_PREFERENCES[nextIndex] ?? DEFAULT_THEME_PREFERENCE;
}
