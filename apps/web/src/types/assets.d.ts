/**
 * Ambient module declarations for non-code assets imported by the web app.
 *
 * Next.js resolves these imports at bundle time; this declaration lets
 * `tsc --noEmit` type-check global stylesheet side-effect imports such as
 * `import './globals.css'`. CSS Module imports (`*.module.css`) are already
 * declared by Next's own `next/types/global.d.ts`.
 */
declare module '*.css';
