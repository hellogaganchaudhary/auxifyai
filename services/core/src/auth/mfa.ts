/**
 * MFA requirement resolution (Req 33.5, 33.6, 33.7).
 *
 * The single, pure decision the Auth_Service relies on to decide whether a
 * second factor must be presented before establishing a session. Keeping it as
 * a standalone, side-effect-free function makes it directly testable and is the
 * exact core Property 51 (task 20.2) validates:
 *
 *   MFA is required if and only if at least one condition holds —
 *     - it is enabled for the user (Req 33.5),
 *     - the user holds a privileged role of `super_admin` or `admin` (Req 33.6),
 *       or
 *     - the user's Organization mandates MFA (Req 33.7).
 */

import type { Role } from '@auxify/types';

import {
  MFA_PRIVILEGED_ROLES,
  type MfaRequirement,
  type MfaRequirementInput,
  type MfaRequirementReason,
} from './types.js';

/**
 * Whether a set of roles includes a privileged role that always requires MFA
 * (Req 33.6).
 *
 * @param roles The user's roles.
 * @returns `true` if any role is `super_admin` or `admin`.
 */
export function hasPrivilegedRole(roles: readonly Role[]): boolean {
  return roles.some((role) => MFA_PRIVILEGED_ROLES.includes(role));
}

/**
 * Resolve whether a second factor is required, and which condition(s) triggered
 * it (Req 33.5, 33.6, 33.7).
 *
 * The result's `required` is `true` whenever any condition holds; `reasons`
 * lists every condition that triggered it (so a caller can explain the
 * requirement), in a stable order. This is the if-and-only-if core of
 * Property 51.
 *
 * @param input The user's roles, per-user MFA flag, and Organization MFA policy.
 * @returns The structured {@link MfaRequirement}.
 */
export function resolveMfaRequirement(input: MfaRequirementInput): MfaRequirement {
  const reasons: MfaRequirementReason[] = [];
  if (input.userMfaEnabled) {
    reasons.push('user_enabled');
  }
  if (hasPrivilegedRole(input.roles)) {
    reasons.push('privileged_role');
  }
  if (input.orgMfaRequired) {
    reasons.push('org_policy');
  }
  return { required: reasons.length > 0, reasons };
}
