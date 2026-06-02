/**
 * Scheduler and workflow-execution typed errors (Req 17.1, 17.2, 17.4).
 *
 * These are the *rejection* errors the Scheduler and workflow executor raise
 * for malformed input or structural violations — distinct from a workflow step
 * *failure*, which is an ordinary recorded {@link WorkflowStepOutcome} on the
 * run result, not a thrown error (Req 17.4). Each projects into the
 * platform-wide serializable {@link PlatformError} (Req 46.8) so the same wire
 * shape crosses the REST_API, the WebSocket_Gateway, and the SDK, and carries
 * structured, secret-free `details`:
 *
 *  - {@link InvalidCadenceError} — a {@link Cadence} could not be parsed into a
 *    schedule (malformed cron expression, non-positive interval, …) so no next
 *    due time can ever be computed (Req 17.1).
 *  - {@link InvalidWorkflowError} — a {@link Workflow}'s step graph is
 *    ill-formed (duplicate step ids, a step referencing an unknown or
 *    not-yet-executed step) so it cannot be executed deterministically in
 *    dependency order (Req 17.2).
 *  - {@link DuplicateScheduleError} — a workflow id was registered with the
 *    Scheduler more than once (Req 17.1).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { CadenceKind } from './types.js';

/** The stable machine-readable code for an unparseable cadence (Req 17.1). */
export const INVALID_CADENCE_CODE = 'SCHEDULER_INVALID_CADENCE' as const;

/** The stable machine-readable code for an ill-formed workflow graph (Req 17.2). */
export const INVALID_WORKFLOW_CODE = 'SCHEDULER_INVALID_WORKFLOW' as const;

/** The stable machine-readable code for a duplicate schedule registration (Req 17.1). */
export const DUPLICATE_SCHEDULE_CODE = 'SCHEDULER_DUPLICATE_SCHEDULE' as const;

/**
 * Thrown when a {@link Cadence} cannot be parsed into a usable schedule, so the
 * Scheduler can never compute a next due time for it (Req 17.1).
 *
 * Covers a malformed cron expression, a non-positive/non-finite interval, and a
 * non-finite one-shot instant. Categorized `validation` (bad client input).
 */
export class InvalidCadenceError extends Error {
  /** The cadence kind that failed to parse. */
  readonly cadenceKind: CadenceKind;
  /** A short, secret-free reason describing why the cadence is invalid. */
  readonly reason: string;

  constructor(cadenceKind: CadenceKind, reason: string) {
    super(`Invalid ${cadenceKind} cadence: ${reason}`);
    this.name = 'InvalidCadenceError';
    this.cadenceKind = cadenceKind;
    this.reason = reason;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_CADENCE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_CADENCE_CODE,
      message: this.message,
      correlationId,
      details: { cadenceKind: this.cadenceKind, reason: this.reason },
    });
  }
}

/**
 * Thrown when a {@link Workflow}'s step graph is ill-formed and therefore not
 * executable in a deterministic dependency order (Req 17.2).
 *
 * Covers a duplicate step id and a step whose `inputRefs` names an unknown step
 * or a step that is not ordered strictly before it (a forward/cyclic reference
 * the executor could not satisfy). Categorized `validation`.
 */
export class InvalidWorkflowError extends Error {
  /** The id of the workflow that is ill-formed. */
  readonly workflowId: string;
  /** A short, secret-free reason describing the structural problem. */
  readonly reason: string;
  /** The step ids implicated in the problem (e.g. the offending references). */
  readonly stepIds: readonly string[];

  constructor(workflowId: string, reason: string, stepIds: readonly string[] = []) {
    super(`Invalid workflow "${workflowId}": ${reason}`);
    this.name = 'InvalidWorkflowError';
    this.workflowId = workflowId;
    this.reason = reason;
    this.stepIds = [...stepIds];
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_WORKFLOW_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_WORKFLOW_CODE,
      message: this.message,
      correlationId,
      details: { workflowId: this.workflowId, reason: this.reason, stepIds: this.stepIds },
    });
  }
}

/**
 * Thrown when a workflow id is registered with the Scheduler while a schedule
 * for it already exists (Req 17.1).
 *
 * Categorized `conflict` (a state conflict, surfaced as HTTP 409).
 */
export class DuplicateScheduleError extends Error {
  /** The workflow id that was already registered. */
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`A schedule for workflow "${workflowId}" is already registered`);
    this.name = 'DuplicateScheduleError';
    this.workflowId = workflowId;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `conflict`, code {@link DUPLICATE_SCHEDULE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'conflict',
      code: DUPLICATE_SCHEDULE_CODE,
      message: this.message,
      correlationId,
      details: { workflowId: this.workflowId },
    });
  }
}
