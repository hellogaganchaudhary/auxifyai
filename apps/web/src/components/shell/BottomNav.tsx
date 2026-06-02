'use client';

/**
 * Mobile bottom navigation bar (Requirement 41.1).
 *
 * On mobile-sized viewports the left sidebar is hidden and the primary
 * destinations move to a fixed bar pinned to the bottom of the screen. Each
 * destination is a real Next `<Link>` (keyboard-focusable and operable, Req
 * 41.4) rendered inside a `<nav aria-label="Primary">` landmark; the link for
 * the current route is marked with `aria-current="page"` (Req 41.5). Glyphs are
 * decorative (`aria-hidden`) and every item keeps a visible text label plus the
 * accessible name from that label.
 *
 * The bar is CSS-hidden above the mobile breakpoint (see `globals.css`), so it
 * is rendered unconditionally and simply not shown on tablet/desktop.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PRIMARY_NAV_ITEMS, isActiveRoute } from '@/lib/navigation';

/** The fixed bottom navigation bar shown on mobile viewports. */
export function BottomNav() {
  const pathname = usePathname() ?? '/';

  return (
    <nav className="bottom-nav" aria-label="Primary">
      <ul className="bottom-nav__list">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const active = isActiveRoute(item.href, pathname);
          return (
            <li key={item.id} className="bottom-nav__item">
              <Link
                href={item.href}
                className="bottom-nav__link"
                aria-current={active ? 'page' : undefined}
              >
                <span className="bottom-nav__glyph" aria-hidden="true">
                  {item.glyph}
                </span>
                <span className="bottom-nav__label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
