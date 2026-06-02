/**
 * The default, permissions-based {@link PageAuthorizer} (Req 26.6).
 *
 * {@link PermissionsPageAuthorizer} evaluates a page's configured
 * {@link PagePermissions} against a {@link Principal} to decide whether a
 * view/edit/comment/manage action is permitted. It is the model-free default the
 * Knowledge_Hub_Service composes; a production deployment may inject an
 * authorizer backed by the platform Access_Control without changing the service
 * (the service treats the result identically and audits every denial, Req 26.9).
 *
 * The decision is fail-closed:
 *   - a cross-Organization page is always denied;
 *   - an Organization `admin`/`super_admin`, and the page's author, always retain
 *     full access (so a page is never orphaned by its own permissions);
 *   - otherwise `view` and `comment` require Project membership with
 *     `projectViewers` (or an explicit viewer/editor grant), and `edit` and
 *     `manage` require Project membership with `projectEditors` (or an explicit
 *     editor grant).
 */

import type { Principal, Role } from '@auxify/types';

import type {
  KnowledgePage,
  PageAction,
  PageAuthorizer,
  PageAuthzDecision,
} from './types.js';

/** Roles that always retain full page access within their Organization. */
const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['admin', 'super_admin']);

/** Whether the principal holds an Organization admin role. */
function isOrgAdmin(principal: Principal): boolean {
  return principal.roles.some((role) => ADMIN_ROLES.has(role));
}

/** Whether the principal is a member of the page's owning Project space. */
function inProject(principal: Principal, page: KnowledgePage): boolean {
  return principal.projectIds.includes(page.projectId);
}

/** Build an allow verdict. */
function allow(reason: string): PageAuthzDecision {
  return { allowed: true, reason };
}

/** Build a deny verdict. */
function deny(reason: string): PageAuthzDecision {
  return { allowed: false, reason };
}

/**
 * The default {@link PageAuthorizer} that enforces a page's configured
 * {@link PagePermissions} (Req 26.6).
 */
export class PermissionsPageAuthorizer implements PageAuthorizer {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract
  async authorize(
    principal: Principal,
    page: KnowledgePage,
    action: PageAction,
  ): Promise<PageAuthzDecision> {
    // Fail closed across an Organization boundary (Req 1.3, 1.4).
    if (principal.organizationId !== page.organizationId) {
      return deny(
        `principal Organization "${principal.organizationId}" does not own page Organization "${page.organizationId}"`,
      );
    }

    // The author and Organization admins always retain full access.
    if (principal.userId === page.authorId) {
      return allow('principal is the page author');
    }
    if (isOrgAdmin(principal)) {
      return allow('principal is an Organization administrator');
    }

    const perms = page.permissions;
    const member = inProject(principal, page);
    const explicitViewer = perms.viewerIds.includes(principal.userId);
    const explicitEditor = perms.editorIds.includes(principal.userId);

    switch (action) {
      case 'view':
      case 'comment': {
        // Viewing/commenting requires a view grant (which an editor implies).
        const canView =
          (member && perms.projectViewers) ||
          (member && perms.projectEditors) ||
          explicitViewer ||
          explicitEditor;
        return canView
          ? allow(`principal may ${action} the page`)
          : deny(`principal lacks view permission for the page`);
      }
      case 'edit':
      case 'manage': {
        const canEdit = (member && perms.projectEditors) || explicitEditor;
        return canEdit
          ? allow(`principal may ${action} the page`)
          : deny(`principal lacks edit permission for the page`);
      }
      default: {
        // Exhaustiveness guard: an unknown action is denied (fail-closed).
        return deny(`unknown action "${String(action)}"`);
      }
    }
  }
}
