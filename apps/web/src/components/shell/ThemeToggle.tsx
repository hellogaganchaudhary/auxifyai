'use client';

/**
 * Light / dark / system theme switch (Requirement 40.4).
 *
 * A small segmented control that lets the user pick a {@link ThemePreference};
 * selecting an option applies it immediately through the {@link ThemeProvider}.
 * Each option is a toggle button with `aria-pressed` reflecting the active
 * choice so the control is understandable to assistive technology.
 */
import { THEME_PREFERENCES, themeLabel } from '@/lib/theme';
import { useTheme } from './ThemeProvider';

/** The segmented light/dark/system control used in settings and the shell. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div
      className="theme-toggle"
      role="group"
      aria-label="Color theme"
    >
      {THEME_PREFERENCES.map((option) => (
        <button
          key={option}
          type="button"
          className="theme-toggle__option"
          aria-pressed={preference === option}
          onClick={() => setPreference(option)}
        >
          {themeLabel(option)}
        </button>
      ))}
    </div>
  );
}
