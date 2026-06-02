/**
 * Audit_Service and the shared audit ports (Req 37).
 *
 * Exposes:
 *   - the narrow {@link AuditRecorder} port and its {@link AuditEvent} shape
 *     (in `./recorder`) that audited domains such as the Tenancy_Service depend
 *     on, so they never take a hard dependency on the concrete service;
 *   - the append-only {@link AuditLogRepository} over `audit_logs` and its
 *     {@link AuditRecord}/{@link AuditQuery}/{@link AppendAuditInput} types;
 *   - the {@link AuditService} that implements the port (record + query only,
 *     never mutating), built on the repository;
 *   - the 7-year retention policy and helpers (Req 37.4).
 */

// The shared port consumed by audited domains and implemented by AuditService.
export type { AuditRecorder, AuditEvent } from './recorder.js';

// Append-only repository over `audit_logs`.
export {
  AuditLogRepository,
  type AuditRecord,
  type AuditQuery,
  type AppendAuditInput,
} from './audit-repository.js';

// The concrete Audit_Service (append + query only).
export { AuditService, type AuditServiceOptions } from './audit-service.js';

// 7-year retention policy and helpers (Req 37.4).
export {
  AUDIT_RETENTION_YEARS,
  AUDIT_RETENTION_POLICY,
  auditRetentionCutoff,
  isWithinAuditRetention,
  type AuditRetentionPolicy,
} from './retention.js';
