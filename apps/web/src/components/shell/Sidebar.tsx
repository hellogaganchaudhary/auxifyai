'use client';

/**
 * Left navigation sidebar for the application shell (Requirement 40.1).
 *
 * Renders links to all twelve feature screens (Req 40.2), grouped into
 * sections, using Next `<Link>`. The link matching the current route is marked
 * with `aria-current="page"` so both sighted and assistive-technology users can
 * tell where they are. The navigation is a semantic `<nav>` landmark with an
 * accessible name.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { forwardRef } from 'react';
import { HOME_NAV_ITEM, groupedNavItems, isActiveRoute } from '@/lib/navigation';
import { ThemeToggle } from './ThemeToggle';

/** Props for the sidebar; all optional so desktop usage stays unchanged. */
interface SidebarProps {
  /** DOM id, referenced by the header menu toggle's `aria-controls` (drawer mode). */
  id?: string;
  /**
   * Called whenever a navigation link is activated. The shell uses this to
   * close the off-canvas drawer after navigation on tablet/mobile.
   */
  onNavigate?: () => void;
}

/**
 * The shell's primary navigation sidebar.
 *
 * On desktop it is a permanent grid column; on tablet/mobile the shell renders
 * the same component as an off-canvas drawer (see `globals.css`). The forwarded
 * ref points at the `<nav>` element so the shell can move focus to the first
 * link when the drawer opens (Req 41.4).
 */
export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { id, onNavigate },
  ref,
) {
  const pathname = usePathname() ?? '/';
  const sections = groupedNavItems();

  return (
    <nav className="sidebar" aria-label="Primary" id={id} ref={ref}>
      <Link
        href={HOME_NAV_ITEM.href}
        className="sidebar__brand"
        aria-label="Auxify home"
        onClick={onNavigate}
      >
        <span className="sidebar__brand-mark" aria-hidden="true">
          A
        </span>
        <span>Auxify</span>
      </Link>

      <div className="sidebar__nav">
        <div className="sidebar__group">
          <ul className="sidebar__list">
            <li>
              <Link
                href={HOME_NAV_ITEM.href}
                className="sidebar__link"
                aria-current={isActiveRoute(HOME_NAV_ITEM.href, pathname) ? 'page' : undefined}
                onClick={onNavigate}
              >
                <span className="sidebar__glyph" aria-hidden="true">
                  {HOME_NAV_ITEM.glyph}
                </span>
                <span>{HOME_NAV_ITEM.label}</span>
              </Link>
            </li>
          </ul>
        </div>

        {sections.map((section) => (
          <div key={section.group} className="sidebar__group">
            <div className="sidebar__group-label" id={`nav-group-${section.group}`}>
              {section.group}
            </div>
            <ul className="sidebar__list" aria-labelledby={`nav-group-${section.group}`}>
              {section.items.map((item) => {
                const active = isActiveRoute(item.href, pathname);
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className="sidebar__link"
                      aria-current={active ? 'page' : undefined}
                      title={item.description}
                      onClick={onNavigate}
                    >
                      <span className="sidebar__glyph" aria-hidden="true">
                        {item.glyph}
                      </span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="sidebar__footer">
        <span className="subtle" id="sidebar-theme-label">
          Theme
        </span>
        <ThemeToggle />
      </div>
    </nav>
  );
});
