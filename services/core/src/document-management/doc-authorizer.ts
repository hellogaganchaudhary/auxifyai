/**
 * The default, permissions-based {@link DocAuthorizer} (Req 28.4).
 *
 * {@link PermissionsDocAuthorizer} evaluates a document's configured
 * {@link DocPermissions} against a {@link Principal} to decide whether a
 * view/edit/delete/manage action is permitted. It is the model-free default the
 * Document_Management_Service composes; a production deployment may inject an
 * authorizer backed by the platform Access_Control without changing the service
 * (the service treats the result identically and audits every denial, Req 28.8).
 *
 * The decision is fail-closed:
 *   - a cross-Organization document is always denied;
 *   - an Organization `admin`/`super_admin`, and the document's owner, always
 *     retain full access (so a document is never orphaned by its own
 *     permissions);
 *   - otherwise `view` requires Project membership with `projectViewers` (or an
 *     explicit viewer/editor grant), and `edit`/`delete`/`manage` require Project
 *     membership with `projectEditors` (or an explicit editor grant).
 */

import type { Principal, Role } from '@auxify/types';

import type { Document, DocAction, DocAuthorizer, DocAuthzDecision } from './types.js';

/** Roles that always retain full document access within their Organization. */
const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['admin', 'super_admin']);

/** Whether the principal holds an Organization admin role. */
function isOrgAdmin(principal: Principal): boolean {
  return principal.roles.some((role) => ADMIN_ROLES.has(role));
}

/** Whether the principal is a member of the document's owning Project. */
function inProject(principal: Principal, document: Document): boolean {
  return principal.projectIds.includes(document.projectId);
}

/** Build an allow verdict. */
function allow(reason: string): DocAuthzDecision {
  return { allowed: true, reason };
}

/** Build a deny verdict. */
function deny(reason: string): DocAuthzDecision {
  return { allowed: false, reason };
}

/**
 * The default {@link DocAuthorizer} that enforces a document's configured
 * {@link DocPermissions} (Req 28.4).
 */
export class PermissionsDocAuthorizer implements DocAuthorizer {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract
  async authorize(
    principal: Principal,
    document: Document,
    action: DocAction,
  ): Promise<DocAuthzDecision> {
    // Fail closed across an Organization boundary (Req 1.3, 1.4).
    if (principal.organizationId !== document.organizationId) {
      return deny(
        `principal Organization "${principal.organizationId}" does not own document Organization "${document.organizationId}"`,
      );
    }

    // The owner and Organization admins always retain full access.
    if (principal.userId === document.ownerId) {
      return allow('principal is the document owner');
    }
    if (isOrgAdmin(principal)) {
      return allow('principal is an Organization administrator');
    }

    const perms = document.permissions;
    const member = inProject(principal, document);
    const explicitViewer = perms.viewerIds.includes(principal.userId);
    const explicitEditor = perms.editorIds.includes(principal.userId);

    switch (action) {
      case 'view': {
        // Viewing requires a view grant (which an editor implies).
        const canView =
          (member && perms.projectViewers) ||
          (member && perms.projectEditors) ||
          explicitViewer ||
          explicitEditor;
        return canView
          ? allow('principal may view the document')
          : deny('principal lacks view permission for the document');
      }
      case 'edit':
      case 'delete':
      case 'manage': {
        const canEdit = (member && perms.projectEditors) || explicitEditor;
        return canEdit
          ? allow(`principal may ${action} the document`)
          : deny('principal lacks edit permission for the document');
      }
      default: {
        // Exhaustiveness guard: an unknown action is denied (fail-closed).
        return deny(`unknown action "${String(action)}"`);
      }
    }
  }
}
