/**
 * Agent_Runtime typed errors (Req 15.1).
 *
 * The runtime is mostly *non-throwing*: a denied tool (Req 16.3), invalid tool
 * input (Req 16.2), an unknown tool, a withheld approval (Req 15.5), or a tool
 * handler that throws are all ordinary {@link import('./types.js').AgentStepRecord}
 * outcomes recorded in the run — never exceptions — because Req 15.6 requires
 * every such attempt to be a recorded step the model can observe and iterate on.
 *
 * Only a *structurally invalid run input* — an input the runtime cannot even
 * begin to execute — is a thrown error, surfaced as a fail-closed
 * {@link InvalidAgentRunError}. It projects into the platform-wide serializable
 * {@link PlatformError} (Req 46.8) so the same wire shape crosses the REST_API,
 * the WebSocket_Gateway, and the SDK, carrying structured, secret-free details
 * (Req 34.7).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for a structurally invalid agent run input (Req 15.1). */
export const INVALID_AGENT_RUN_CODE = 'INVALID_AGENT_RUN' as const;

/**
 * Thrown when an {@link import('./types.js').AgentRunInput} is structurally
 * invalid and the run cannot begin (Req 15.1).
 *
 * `reason` explains the structural problem (e.g. a missing agent, a missing
 * model, a non-positive `maxSteps`, a negative `budgetCap`). Surfaced as
 * `validation`. Every *runtime* failure during a run is instead a recorded step
 * outcome, not this error.
 */
export class InvalidAgentRunError extends Error {
  constructor(reason: string) {
    super(`Invalid agent run: ${reason}`);
    this.name = 'InvalidAgentRunError';
  }

  /**
   * Project into the platform-wide error shape (`validation`,
   * {@link INVALID_AGENT_RUN_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_AGENT_RUN_CODE,
      message: this.message,
      correlationId,
    });
  }
}
