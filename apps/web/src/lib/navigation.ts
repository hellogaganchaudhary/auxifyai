/**
 * The canonical navigation registry for the application shell.
 *
 * A single source of truth for the twelve feature screens (Requirement 40.2)
 * plus the home dashboard, shared by the `Sidebar`, the home landing page, and
 * the keyboard-shortcut help so routes, labels, and descriptions never drift.
 */

/** A single navigable destination in the shell. */
export interface NavItem {
  /** Stable id, used as a React key. */
  id: string;
  /** The route path (Next `<Link href>`). */
  href: string;
  /** Short label shown in the sidebar. */
  label: string;
  /** A one-line description shown on the home dashboard and as an aria hint. */
  description: string;
  /** A short text/emoji glyph used as a lightweight icon (no icon library). */
  glyph: string;
  /** The grouping the item belongs to, for sectioning the sidebar. */
  group: NavGroup;
}

/** The sidebar sections used to group navigation items. */
export type NavGroup = 'Workspace' | 'Knowledge' | 'Agents' | 'Insights' | 'Administration';

/** The ordered list of sidebar groups. */
export const NAV_GROUPS: readonly NavGroup[] = [
  'Workspace',
  'Knowledge',
  'Agents',
  'Insights',
  'Administration',
] as const;

/**
 * The home dashboard destination. Kept separate from {@link FEATURE_NAV_ITEMS}
 * because it is the landing page rather than one of the twelve feature screens.
 */
export const HOME_NAV_ITEM: NavItem = {
  id: 'home',
  href: '/',
  label: 'Home',
  description: 'Overview dashboard with quick links into every workspace.',
  glyph: '◇',
  group: 'Workspace',
};

/** The twelve feature screens required by Req 40.2, in sidebar order. */
export const FEATURE_NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'chat',
    href: '/chat',
    label: 'Chat',
    description: 'Converse with AI models, stream responses, and cite sources.',
    glyph: '💬',
    group: 'Workspace',
  },
  {
    id: 'search',
    href: '/search',
    label: 'Unified Search',
    description: 'Search across conversations, knowledge, documents, and the web.',
    glyph: '🔍',
    group: 'Workspace',
  },
  {
    id: 'team-communication',
    href: '/team-communication',
    label: 'Team Communication',
    description: 'Channels and direct messages for your team.',
    glyph: '🗨️',
    group: 'Workspace',
  },
  {
    id: 'knowledge-hub',
    href: '/knowledge-hub',
    label: 'Knowledge Hub',
    description: 'Curated collections, pages, and connected knowledge sources.',
    glyph: '📚',
    group: 'Knowledge',
  },
  {
    id: 'knowledge-base',
    href: '/knowledge-base',
    label: 'Knowledge Base',
    description: 'Indexed documents and chunks powering retrieval.',
    glyph: '🧠',
    group: 'Knowledge',
  },
  {
    id: 'documents',
    href: '/documents',
    label: 'Document Management',
    description: 'Upload, organize, and manage files and documents.',
    glyph: '📄',
    group: 'Knowledge',
  },
  {
    id: 'prompts',
    href: '/prompts',
    label: 'Prompt Library',
    description: 'Reusable, parameterized prompt templates.',
    glyph: '⌘',
    group: 'Workspace',
  },
  {
    id: 'agent-builder',
    href: '/agent-builder',
    label: 'Agent Builder',
    description: 'Design agents, tools, and multi-step workflows.',
    glyph: '🛠️',
    group: 'Agents',
  },
  {
    id: 'agent-monitor',
    href: '/agent-monitor',
    label: 'Agent Monitor',
    description: 'Observe live and historical agent runs.',
    glyph: '📈',
    group: 'Agents',
  },
  {
    id: 'analytics',
    href: '/analytics',
    label: 'Analytics',
    description: 'Usage, cost, and adoption metrics across the platform.',
    glyph: '📊',
    group: 'Insights',
  },
  {
    id: 'admin',
    href: '/admin',
    label: 'Admin Panel',
    description: 'Manage organizations, teams, members, and policies.',
    glyph: '🛡️',
    group: 'Administration',
  },
  {
    id: 'settings',
    href: '/settings',
    label: 'Settings',
    description: 'Personal preferences, including appearance and theme.',
    glyph: '⚙️',
    group: 'Administration',
  },
] as const;

/** Every navigable item, home first, for full-registry iteration. */
export const ALL_NAV_ITEMS: readonly NavItem[] = [HOME_NAV_ITEM, ...FEATURE_NAV_ITEMS];

/**
 * Look up a navigation item by id from the full registry.
 *
 * @param id The item id to find.
 * @returns The matching {@link NavItem}, or `undefined` if none matches.
 */
export function navItemById(id: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((item) => item.id === id);
}

/**
 * The primary destinations surfaced in the mobile bottom navigation bar
 * (Requirement 41.1).
 *
 * The bottom bar has room for only a handful of items, so it shows the most
 * frequently used workspaces; the full set of screens stays reachable from the
 * navigation drawer (the off-canvas sidebar) via the header menu toggle. Order
 * matches the desired left-to-right tab order. Unknown ids are filtered out so
 * the list never contains holes.
 */
export const PRIMARY_NAV_ITEMS: readonly NavItem[] = ['home', 'chat', 'search', 'knowledge-hub']
  .map(navItemById)
  .filter((item): item is NavItem => item !== undefined);

/**
 * Group the feature navigation items by their {@link NavGroup} for rendering a
 * sectioned sidebar.
 *
 * @returns An ordered list of `{ group, items }` pairs; empty groups are omitted.
 */
export function groupedNavItems(): { group: NavGroup; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({
    group,
    items: FEATURE_NAV_ITEMS.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}

/**
 * Decide whether a nav item is the active route for `aria-current` marking.
 *
 * The home route matches only an exact `/`; every other route also matches its
 * nested sub-paths (e.g. `/chat/123`).
 *
 * @param itemHref The candidate item's href.
 * @param pathname The current pathname.
 * @returns `true` when the item represents the active route.
 */
export function isActiveRoute(itemHref: string, pathname: string): boolean {
  if (itemHref === '/') {
    return pathname === '/';
  }
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}
