/**
 * The pure page-hierarchy navigation core (Req 26.2).
 *
 * {@link buildNavigationTree} turns a flat list of a Project space's pages into
 * the hierarchical navigation tree the web client renders, and
 * {@link wouldCreateCycle} is the guard the Knowledge_Hub_Service uses to reject
 * a re-parent that would create a cycle. Both are pure functions over the page
 * list, with no I/O, so the hierarchy behaviour is directly unit-testable.
 */

import type { KnowledgePage, PageTreeNode } from './types.js';

/** Stable ordering for sibling pages: by title (case-insensitive), then id. */
function compareSiblings(a: PageTreeNode, b: PageTreeNode): number {
  const at = a.title.toLowerCase();
  const bt = b.title.toLowerCase();
  if (at < bt) return -1;
  if (at > bt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Build the hierarchical navigation tree for a set of pages (Req 26.2).
 *
 * Pages whose `parentId` is `undefined` — or points outside the supplied set —
 * become roots, so the result always contains every supplied page exactly once
 * (no page is dropped because of a dangling parent). Children are ordered by
 * title then id for a stable rendering.
 *
 * @param pages The Project space's pages (already tenant-scoped).
 * @returns The root nodes of the navigation tree, each with nested children.
 */
export function buildNavigationTree(pages: readonly KnowledgePage[]): PageTreeNode[] {
  const nodes = new Map<string, PageTreeNode>();
  for (const page of pages) {
    const node: PageTreeNode = { id: page.id, title: page.title, children: [] };
    if (page.parentId !== undefined) node.parentId = page.parentId;
    nodes.set(page.id, node);
  }

  const roots: PageTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId !== undefined ? nodes.get(node.parentId) : undefined;
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      // No parent, or a parent outside this set → treat as a root.
      roots.push(node);
    }
  }

  // Stable ordering at every level.
  const sortRec = (level: PageTreeNode[]): void => {
    level.sort(compareSiblings);
    for (const node of level) sortRec(node.children);
  };
  sortRec(roots);

  return roots;
}

/**
 * Whether making `parentId` the parent of `pageId` would create a cycle in the
 * page tree (Req 26.2).
 *
 * A cycle forms when `parentId` is `pageId` itself or any descendant of
 * `pageId`. Walking up from `parentId` via `parentId` edges, if we ever reach
 * `pageId` the new edge would close a loop. The `parentOf` map is built from the
 * current page set.
 *
 * @param pageId The page being re-parented.
 * @param parentId The proposed new parent.
 * @param pages The current Project space pages (to resolve ancestry).
 * @returns `true` when the re-parent would create a cycle.
 */
export function wouldCreateCycle(
  pageId: string,
  parentId: string,
  pages: readonly KnowledgePage[],
): boolean {
  if (pageId === parentId) return true;
  const parentOf = new Map<string, string | undefined>();
  for (const page of pages) parentOf.set(page.id, page.parentId);

  // Walk ancestors of the proposed parent; if we reach pageId, it is a cycle.
  let cursor: string | undefined = parentId;
  const seen = new Set<string>();
  while (cursor !== undefined) {
    if (cursor === pageId) return true;
    if (seen.has(cursor)) break; // pre-existing cycle guard; stop walking
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}
