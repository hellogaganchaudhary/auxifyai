/**
 * Shared page header for feature screens.
 *
 * A presentational server component that renders the screen's `<h1>` title and
 * an optional subtitle inside the `.page` wrapper, giving every screen a
 * consistent heading hierarchy (Req 40.3) and a single top-level `<h1>` per
 * page for a logical document outline.
 */
import type { ReactNode } from 'react';

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** The screen's top-level title. */
  title: string;
  /** An optional one-line description shown beneath the title. */
  subtitle?: string;
  /** Optional actions (buttons/links) rendered on the trailing side. */
  actions?: ReactNode;
}

/** Renders a consistent screen header with title, subtitle, and optional actions. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="page__header row row--between row--wrap">
      <div>
        <h1 className="page__title">{title}</h1>
        {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
