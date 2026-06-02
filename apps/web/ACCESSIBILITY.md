# Accessibility (WCAG 2.1 Level AA)

This document describes the accessibility approach for the Auxify web client
(Requirement 41). It records the responsive breakpoints, the keyboard model, the
ARIA/landmark structure, and the colour-contrast audit. It is a conformance
*approach*, not a conformance *claim*: see "Conformance status" below.

## Responsive layout (Req 41.1, 41.2)

The shell renders three layout modes driven purely by viewport width. The CSS
media queries in `src/app/globals.css` and the pure helpers in
`src/lib/responsive.ts` use the same breakpoints, so the visual layout and the
JavaScript behaviour never disagree.

| Mode    | Width            | Left navigation                         | Context panel        |
| ------- | ---------------- | --------------------------------------- | -------------------- |
| Desktop | `> 1024px`       | Permanent sidebar grid column           | Permanent column     |
| Tablet  | `<= 1024px`      | Collapsible off-canvas drawer + toggle  | Right overlay sheet  |
| Mobile  | `<= 640px`       | Fixed **bottom navigation bar**         | Full-width sheet     |

- **Mobile (Req 41.1):** the left sidebar is replaced by a fixed bottom
  `<nav aria-label="Primary">` bar (`BottomNav.tsx`) holding the primary
  destinations. The active route is marked `aria-current="page"`. The main area
  is a single full-width column and reserves space so content is never hidden
  behind the bar (including `env(safe-area-inset-bottom)`).
- **Tablet (Req 41.2):** the sidebar collapses to an off-canvas drawer behind a
  header hamburger `<button>` that exposes `aria-expanded` and `aria-controls`.
  The context panel collapses to an overlay sheet. A backdrop scrim closes both.
- **Desktop:** unchanged three-region grid.

The drawer open/close logic is the pure `sidebarReducer` (`responsive.ts`),
unit-tested in `responsive.test.ts`. Switching to desktop force-closes the
drawer so it can never get "stuck open" once the sidebar becomes permanent.

## Keyboard model (Req 41.4)

Every interactive control is a native, focusable element (`<a>`, `<button>`,
`<input>`), so all controls are reachable and operable by keyboard with a
logical tab order:

- **Skip link:** a "Skip to main content" link is the first focusable element
  and reveals itself on focus, jumping to `#main-content`.
- **Focus indicator:** a `:focus-visible` outline (2px, `--focus-ring`) is shown
  on all controls and meets the 3:1 non-text contrast minimum in both themes.
- **Hamburger drawer:** opening the drawer moves focus to the first navigation
  link; `Escape` (or the scrim) closes it and returns focus to the toggle. The
  toggle exposes `aria-expanded` / `aria-controls`.
- **Context sheet:** in overlay mode it takes `role="dialog"` + `aria-modal` and
  is closable with `Escape` or the scrim.
- **Shortcuts (Req 40.6):** the global shortcut handler (`g`-sequences, `/` to
  focus search, `?` for help, `Escape` to close overlays) continues to work and
  never hijacks typing in inputs/textareas/contenteditable.
- **Reduced motion:** `prefers-reduced-motion` collapses transitions/animations.

No custom keyboard widgets re-implement native semantics; the only custom
toggles (hamburger, context toggle, theme segmented control, panel tabs) are
real `<button>`s that respond to Enter/Space for free.

## ARIA & landmarks (Req 41.5)

- Landmarks: `<nav aria-label="Primary">` (sidebar and bottom nav), `<main>`,
  `<aside aria-label="Contextual panel">`, `<header>`, `role="search"` form.
- Icon-only controls have `aria-label`: the hamburger toggle (label reflects
  open/closed), context-panel toggle, close buttons, and theme options. Glyphs
  are decorative and marked `aria-hidden="true"`.
- Active navigation links use `aria-current="page"`.
- The chat streaming transcript is an `aria-live="polite"` region so streamed
  tokens are announced.
- The shortcuts help and the overlay context sheet use `role="dialog"`,
  `aria-modal="true"`, an accessible name, and `Escape` to close.
- The context-panel tabs use `role="tablist"` / `role="tab"` / `role="tabpanel"`
  with `aria-selected` and `aria-controls`/`aria-labelledby` wiring.

## Colour contrast audit (Req 41.3, 41.5)

Both the light and dark theme tokens in `globals.css` were audited with the
WCAG relative-luminance contrast formula. Normal-size text meets **>= 4.5:1**
against its background, and interactive/focus (non-text) indicators meet
**>= 3:1**. Tokens that fell short were adjusted (documented inline in
`globals.css`):

| Token (theme)            | Before    | After     | Result                                   |
| ------------------------ | --------- | --------- | ---------------------------------------- |
| `--text-subtle` (light)  | `#6b7585` | `#636c7b` | 4.35:1 -> 4.95:1 on `--bg` (text, PASS)  |
| `--warning` (light)      | `#9a6700` | `#8a5e00` | 4.40:1 -> 5.15:1 on `--warning-soft`     |
| `--border-strong` (light)| `#c2c8d0` | `#838a96` | 1.68:1 -> 3.48:1 on `--surface` (UI 3:1) |
| `--border-strong` (dark) | `#3a424e` | `#6a7283` | 1.70:1 -> 3.58:1 on `--surface` (UI 3:1) |

`--border` remains a faint hairline used only for decorative dividers (not the
sole indicator of an interactive control's boundary), so it is not required to
meet the 3:1 UI-component minimum; control edges use `--border-strong`.

A standalone forced-colors (Windows High Contrast) block keeps focus and the
active-route indicator visible when system colours override the palette.

## Conformance status

This is an engineering effort toward WCAG 2.1 Level AA, **not** a verified
conformance claim. The contrast ratios above were computed programmatically and
the structure was reviewed against the AA success criteria, but full conformance
cannot be asserted from code review and automated checks alone. Before any
formal claim, the following are still required:

- Automated scans (e.g. axe-core / Lighthouse) on the running app.
- Manual assistive-technology testing (screen readers such as NVDA, JAWS, and
  VoiceOver; keyboard-only navigation; 200%–400% zoom and reflow).
- Expert accessibility review covering criteria that cannot be automated
  (meaningful sequence, focus order in real flows, error identification, etc.).

Treat this document as the current baseline and the checklist of what remains.
