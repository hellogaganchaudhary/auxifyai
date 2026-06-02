/**
 * Compliance_Manager (Req 38.1-38.6, 28.6): the platform's data-governance gate.
 *
 * The Compliance_Manager enforces the Organization's configured data-retention
 * policy across conversations, files, and documents (Req 38.1-38.3, 28.6);
 * honours legal holds — a held resource is exempt from retention deletion;
 * supports data-subject deletion / right-to-erasure on offboarding within 30 days
 * (Req 38.4) and on a GDPR request within 72 hours (Req 38.5); and — fail-closed
 * — blocks any operation whose retention/privacy compliance cannot be verified
 * (Req 38.6). Every governance action is recorded in the Audit_Service (Req 38.2,
 * 38.5, 38.6, 28.6).
 *
 * It is pure orchestration over a small set of injectable ports — a tenant-scoped
 * {@link RetentionPolicyStore} and {@link LegalHoldStore}, the shared
 * {@link import('../audit/index.js').AuditRecorder}, an injectable
 * {@link ComplianceClock}, and the optional {@link RetentionEnforcer} /
 * {@link SubjectDataEraser} seams — so it is fully unit-testable with the
 * in-memory fakes in `./fakes.js`.
 *
 * Surface:
 *   - {@link ComplianceManager} — the service; one cluster of methods per
 *     acceptance criterion (set/get/resolve retention policy; place/release/test
 *     legal hold; evaluate + enforce retention; erase subject data; verify
 *     compliance fail-closed) plus {@link validateRetentionPolicy} (the pure
 *     configuration validator) and the {@link EnforceRetentionResult} shape.
 *   - The pure retention core — {@link retentionDueAtMs}, {@link isPastRetention},
 *     {@link decideCompliance} — and the deadline constants {@link MS_PER_DAY},
 *     {@link OFFBOARDING_ERASURE_WINDOW_MS}, {@link GDPR_ERASURE_WINDOW_MS}.
 *   - The scope builders {@link organizationRetentionScope},
 *     {@link teamRetentionScope}, {@link projectRetentionScope}, the retention
 *     bounds/defaults ({@link MIN_RETENTION_DAYS}, {@link DEFAULT_RETENTION_DAYS}),
 *     the string-union vocabularies with their value lists, and the
 *     {@link systemComplianceClock} default.
 *   - The typed errors plus their stable codes ({@link InvalidRetentionPolicyError},
 *     {@link LegalHoldNotFoundError}, {@link ComplianceBlockedError}).
 *
 * The in-memory test fakes (a hand-advanced {@link ComplianceClock}, in-memory
 * policy/hold stores, a capturing audit recorder, a recording enforcer/eraser,
 * and a sequential id generator) live in `./fakes.js` and are intentionally NOT
 * re-exported from this barrel — they would collide with the equally-named
 * audit-recorder/clock fakes of sibling modules at the package barrel. Following
 * the established convention, the tests import them directly from `./fakes.js`.
 * The {@link import('../audit/index.js').AuditRecorder} /
 * {@link import('../audit/index.js').AuditEvent} ports the manager depends on are
 * likewise NOT re-exported here — they are owned by the Audit_Service barrel
 * (`./audit/index.js`).
 *
 * Naming: the injectable clock is surfaced as {@link ComplianceClock} /
 * {@link systemComplianceClock} (not `Clock` / `systemClock`) and the disposition
 * as {@link RetentionDisposition} (not the Document_Management_Service's
 * `RetentionAction`) so the names never collide with sibling modules in the
 * shared `@auxify/core` barrel.
 */

export {
  ComplianceManager,
  validateRetentionPolicy,
  type ComplianceManagerOptions,
  type ComplianceIdGenerator,
  type EnforceRetentionResult,
} from './compliance-manager.js';

export {
  retentionDueAtMs,
  isPastRetention,
  decideCompliance,
  MS_PER_DAY,
  OFFBOARDING_ERASURE_WINDOW_MS,
  GDPR_ERASURE_WINDOW_MS,
} from './retention.js';

export {
  InvalidRetentionPolicyError,
  LegalHoldNotFoundError,
  ComplianceBlockedError,
  INVALID_RETENTION_POLICY_CODE,
  LEGAL_HOLD_NOT_FOUND_CODE,
  COMPLIANCE_BLOCKED_CODE,
} from './errors.js';

export {
  organizationRetentionScope,
  teamRetentionScope,
  projectRetentionScope,
  isRetentionResourceKind,
  isRetentionDisposition,
  systemComplianceClock,
  MIN_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  RETENTION_RESOURCE_KINDS,
  RETENTION_DISPOSITIONS,
  RETENTION_SCOPE_LEVELS,
  LEGAL_HOLD_STATUSES,
  SUBJECT_ERASURE_REASONS,
  type RetentionResourceKind,
  type RetentionDisposition,
  type RetentionScopeLevel,
  type RetentionScope,
  type RetentionPolicyInput,
  type RetentionPolicy,
  type RetentionPolicySource,
  type LegalHoldStatus,
  type LegalHold,
  type LegalHoldInput,
  type RetainableResource,
  type RetentionDecision,
  type SubjectErasureReason,
  type SubjectErasureRequest,
  type SubjectErasureOutcome,
  type SubjectErasureResult,
  type ComplianceOperation,
  type ComplianceDenialCode,
  type ComplianceDecision,
  type ComplianceClock,
  type RetentionPolicyStore,
  type LegalHoldStore,
  type RetentionEnforcer,
  type SubjectDataEraser,
} from './types.js';
