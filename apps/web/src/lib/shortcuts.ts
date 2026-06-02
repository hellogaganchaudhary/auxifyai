/**
 * Keyboard shortcut registry and pure matching logic (Requirement 40.6).
 *
 * A shortcut maps a key trigger to a named action. Triggers are either a single
 * key (e.g. `/` to focus search, `?` to open the shortcuts help) or a short
 * two-key sequence in the "go to" style (e.g. `g` then `c` to navigate to
 * chat). The matching state machine here is DOM-free and pure so it can be
 * unit-tested without a browser; the `KeyboardShortcuts` client component owns
 * the actual `keydown` listener and invokes the resolved action.
 */

/** The set of actions a registered shortcut can perform (Req 40.6). */
export type ShortcutActionId =
  | 'navigate'
  | 'focus-search'
  | 'open-shortcuts-help'
  | 'close-overlay';

/**
 * A single registered shortcut.
 *
 * `keys` is the ordered trigger: a one-element array for a single-key shortcut
 * or a two-element array for a "go to" sequence. `action` names what happens,
 * and `href` is the navigation target when `action` is `navigate`.
 */
export interface Shortcut {
  /** Stable id for the shortcut, used as a React key and in the help overlay. */
  id: string;
  /** The ordered key trigger (1 key, or a 2-key "g x" sequence). */
  keys: string[];
  /** What the shortcut does when matched. */
  action: ShortcutActionId;
  /** Navigation target, required when `action` is `navigate`. */
  href?: string;
  /** Human-readable description shown in the shortcuts help overlay. */
  description: string;
}

/**
 * The default shortcut registry wired into the shell.
 *
 * The `g <key>` sequences navigate to the twelve feature screens; `/` focuses
 * the unified search, `?` opens the shortcuts help, and `Escape` closes any
 * open overlay.
 */
export const DEFAULT_SHORTCUTS: readonly Shortcut[] = [
  { id: 'goto-home', keys: ['g', 'h'], action: 'navigate', href: '/', description: 'Go to home dashboard' },
  { id: 'goto-chat', keys: ['g', 'c'], action: 'navigate', href: '/chat', description: 'Go to chat' },
  { id: 'goto-knowledge-hub', keys: ['g', 'k'], action: 'navigate', href: '/knowledge-hub', description: 'Go to Knowledge Hub' },
  { id: 'goto-team', keys: ['g', 't'], action: 'navigate', href: '/team-communication', description: 'Go to team communication' },
  { id: 'goto-documents', keys: ['g', 'd'], action: 'navigate', href: '/documents', description: 'Go to document management' },
  { id: 'goto-prompts', keys: ['g', 'p'], action: 'navigate', href: '/prompts', description: 'Go to prompt library' },
  { id: 'goto-agent-builder', keys: ['g', 'b'], action: 'navigate', href: '/agent-builder', description: 'Go to agent builder' },
  { id: 'goto-agent-monitor', keys: ['g', 'm'], action: 'navigate', href: '/agent-monitor', description: 'Go to agent monitor' },
  { id: 'goto-knowledge-base', keys: ['g', 'n'], action: 'navigate', href: '/knowledge-base', description: 'Go to knowledge base' },
  { id: 'goto-analytics', keys: ['g', 'a'], action: 'navigate', href: '/analytics', description: 'Go to analytics dashboard' },
  { id: 'goto-admin', keys: ['g', 'x'], action: 'navigate', href: '/admin', description: 'Go to admin panel' },
  { id: 'goto-settings', keys: ['g', 's'], action: 'navigate', href: '/settings', description: 'Go to settings' },
  { id: 'goto-search', keys: ['g', 'u'], action: 'navigate', href: '/search', description: 'Go to unified search' },
  { id: 'focus-search', keys: ['/'], action: 'focus-search', description: 'Focus the search field' },
  { id: 'open-help', keys: ['?'], action: 'open-shortcuts-help', description: 'Show keyboard shortcuts' },
  { id: 'close-overlay', keys: ['Escape'], action: 'close-overlay', description: 'Close the open overlay' },
] as const;

/** A successful resolution of a key press (or sequence) to a shortcut. */
export interface ShortcutMatch {
  /** The kind of match: a completed shortcut, a pending sequence prefix, or no match. */
  kind: 'matched' | 'pending' | 'none';
  /** The matched shortcut, present only when `kind` is `matched`. */
  shortcut?: Shortcut;
}

/** The leader keys that begin a multi-key sequence (currently just `g`). */
export const SEQUENCE_LEADERS: readonly string[] = ['g'] as const;

/**
 * Normalize a raw `KeyboardEvent.key` into a registry key token.
 *
 * Letters are lower-cased so `Shift`-less and capitalized presses compare
 * equally for sequence leaders; punctuation/named keys (`/`, `?`, `Escape`) are
 * passed through unchanged.
 *
 * @param rawKey The raw `event.key` value.
 * @returns The normalized key token used by the registry.
 */
export function normalizeKey(rawKey: string): string {
  if (rawKey.length === 1) {
    return rawKey.toLowerCase() === rawKey ? rawKey : rawKey.toLowerCase();
  }
  return rawKey;
}

/**
 * Resolve a key press against the registry given the current pending sequence
 * buffer (the keys pressed so far that form an incomplete sequence).
 *
 * The function is a pure transition: it never mutates its inputs. Callers feed
 * the returned `pending` buffer back on the next key press.
 *
 * @param shortcuts The registry to match against.
 * @param pending The keys pressed so far (an in-progress sequence), oldest first.
 * @param key The newly pressed, normalized key.
 * @returns The match outcome plus the next `pending` buffer.
 */
export function resolveKey(
  shortcuts: readonly Shortcut[],
  pending: readonly string[],
  key: string,
): { match: ShortcutMatch; pending: string[] } {
  const sequence = [...pending, key];

  // First, look for an exact match of the full sequence.
  const exact = shortcuts.find(
    (s) => s.keys.length === sequence.length && s.keys.every((k, i) => k === sequence[i]),
  );
  if (exact) {
    return { match: { kind: 'matched', shortcut: exact }, pending: [] };
  }

  // Otherwise, is the sequence a prefix of some longer shortcut? If so, keep
  // it pending so the next key can complete it.
  const isPrefix = shortcuts.some(
    (s) => s.keys.length > sequence.length && sequence.every((k, i) => s.keys[i] === k),
  );
  if (isPrefix) {
    return { match: { kind: 'pending' }, pending: sequence };
  }

  // The new key did not extend the pending sequence. Retry it on its own in
  // case it begins a fresh sequence or is itself a single-key shortcut.
  if (pending.length > 0) {
    return resolveKey(shortcuts, [], key);
  }

  return { match: { kind: 'none' }, pending: [] };
}

/**
 * Render a shortcut's trigger as a display string for the help overlay, e.g.
 * `["g","c"]` becomes `"g then c"` and `["/"]` becomes `"/"`.
 *
 * @param shortcut The shortcut to format.
 * @returns A human-readable trigger description.
 */
export function formatShortcutKeys(shortcut: Shortcut): string {
  return shortcut.keys.join(' then ');
}
