/**
 * Pure workflow step-graph validation and ordering (Req 17.2).
 *
 * The workflow executor must run steps "in their defined order" while "passing
 * each step's output to subsequent steps that reference it" (Req 17.2). This
 * module turns a {@link Workflow}'s steps into a single, deterministic execution
 * order and rejects any graph that cannot be executed that way:
 *
 *  - steps are ordered by non-decreasing {@link WorkflowStep.order}, with ties
 *    broken by their original array position (a stable sort) so the order is
 *    total and deterministic;
 *  - every {@link WorkflowStep.inputRefs} entry must name a *distinct, earlier*
 *    step in that order — a self-reference, an unknown id, or a forward/cyclic
 *    reference is rejected, because the referenced step's output would not yet
 *    exist when the referencing step runs (Req 17.2);
 *  - duplicate step ids are rejected, since outputs are keyed by step id.
 *
 * Keeping this pure and separate from the executor makes the dependency-order
 * guarantee directly testable and keeps the executor focused on running steps.
 */

import { InvalidWorkflowError } from './errors.js';
import type { Workflow, WorkflowStep } from './types.js';

/**
 * Validate a workflow's step graph and return its steps in execution order
 * (Req 17.2).
 *
 * @param workflow The workflow whose steps to validate and order.
 * @returns The steps sorted into a total, deterministic execution order.
 * @throws {InvalidWorkflowError} If a step id is duplicated, or a step
 *   references an unknown step or one not ordered strictly before it.
 */
export function validateWorkflowGraph(workflow: Workflow): WorkflowStep[] {
  // Stable sort by `order`, ties broken by original index (Req 17.2).
  const ordered = workflow.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index)
    .map(({ step }) => step);

  // Reject duplicate step ids — outputs are keyed by id.
  const seen = new Set<string>();
  for (const step of ordered) {
    if (seen.has(step.id)) {
      throw new InvalidWorkflowError(workflow.id, `duplicate step id "${step.id}"`, [step.id]);
    }
    seen.add(step.id);
  }

  // Every referenced id must be a distinct step that appears strictly earlier.
  const executedSoFar = new Set<string>();
  for (const step of ordered) {
    for (const ref of step.inputRefs) {
      if (ref === step.id) {
        throw new InvalidWorkflowError(workflow.id, `step "${step.id}" references itself`, [
          step.id,
        ]);
      }
      if (!seen.has(ref)) {
        throw new InvalidWorkflowError(
          workflow.id,
          `step "${step.id}" references unknown step "${ref}"`,
          [step.id, ref],
        );
      }
      if (!executedSoFar.has(ref)) {
        throw new InvalidWorkflowError(
          workflow.id,
          `step "${step.id}" references "${ref}" which is not ordered before it`,
          [step.id, ref],
        );
      }
    }
    executedSoFar.add(step.id);
  }

  return ordered;
}
