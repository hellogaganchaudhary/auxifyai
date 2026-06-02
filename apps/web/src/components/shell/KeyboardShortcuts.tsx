'use client';

/**
 * Global keyboard-shortcut handler and help overlay (Requirement 40.6).
 *
 * Registers a single document-level `keydown` listener that resolves presses
 * against the shortcut registry in `@/lib/shortcuts` and performs the mapped
 * action: navigate to a screen (`g` then a key), focus the search field (`/`),
 * open this help overlay (`?`), or close an open overlay (`Escape`). Typing in
 * an input/textarea/select or contenteditable is ignored so shortcuts never
 * hijack normal text entry.
 *
 * The matching state machine is the pure `resolveKey` reducer; this component
 * owns only the listener, the pending-sequence ref, and the help overlay UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_SHORTCUTS,
  formatShortcutKeys,
  normalizeKey,
  resolveKey,
  type Shortcut,
} from '@/lib/shortcuts';

/** The DOM id of the search field that `/` focuses (rendered by the shell header). */
export const SEARCH_INPUT_ID = 'global-search-input';

/** Whether the event target is an editable element we should not hijack. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
}

/** The global keyboard-shortcut listener plus the shortcuts-help overlay. */
export function KeyboardShortcuts({
  shortcuts = DEFAULT_SHORTCUTS,
}: {
  shortcuts?: readonly Shortcut[];
}) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingRef = useRef<string[]>([]);

  const performAction = useCallback(
    (shortcut: Shortcut) => {
      switch (shortcut.action) {
        case 'navigate':
          if (shortcut.href) {
            router.push(shortcut.href);
          }
          break;
        case 'focus-search': {
          const input = document.getElementById(SEARCH_INPUT_ID);
          if (input instanceof HTMLElement) {
            input.focus();
          }
          break;
        }
        case 'open-shortcuts-help':
          setHelpOpen(true);
          break;
        case 'close-overlay':
          setHelpOpen(false);
          break;
      }
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never interfere with modified chords (Ctrl/Cmd/Alt) or editable fields,
      // except always allow Escape to close an overlay.
      const isEscape = event.key === 'Escape';
      if (!isEscape) {
        if (event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        if (isEditableTarget(event.target)) {
          return;
        }
      }

      const key = normalizeKey(event.key);
      const { match, pending } = resolveKey(shortcuts, pendingRef.current, key);
      pendingRef.current = pending;

      if (match.kind === 'matched' && match.shortcut) {
        // Don't let `/` or `?` type into the page, and stop sequence keys from
        // scrolling, etc.
        event.preventDefault();
        performAction(match.shortcut);
      } else if (match.kind === 'pending') {
        // Mid-sequence (e.g. after `g`); swallow so it doesn't act on its own.
        event.preventDefault();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, performAction]);

  if (!helpOpen) {
    return null;
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-help-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setHelpOpen(false);
        }
      }}
    >
      <div className="overlay__dialog">
        <div className="row row--between" style={{ marginBottom: 'var(--space-4)' }}>
          <h2 id="shortcuts-help-title" style={{ margin: 0 }}>
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => setHelpOpen(false)}
            aria-label="Close keyboard shortcuts"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <ul className="list-plain stack">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.id} className="row row--between">
              <span>{shortcut.description}</span>
              <span className="row" style={{ gap: 'var(--space-1)' }}>
                {shortcut.keys.map((key, index) => (
                  <span key={`${shortcut.id}-${index}`} className="kbd">
                    {key === ' ' ? 'Space' : key}
                  </span>
                ))}
                <span className="sr-only">{formatShortcutKeys(shortcut)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
