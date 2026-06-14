/**
 * Capability gates for the Provider_Abstraction_Layer (Req 2.8, 2.9).
 *
 * These pure helpers enforce that a request matches the target model's declared
 * capabilities before any provider call is made:
 *   - a chat request carrying image attachments is only valid for a
 *     vision-capable model (Req 2.8), and
 *   - an image-generation request is only valid for an image-modality model
 *     (Req 2.9).
 *
 * Keeping the rule in one place means every adapter (the stub here, and the
 * Bedrock/Azure adapters in task 5.3) enforces capability typing identically.
 */

import type { ChatRequest, ModelInfo } from '@auxify/types';

import { UnsupportedModelCapabilityError } from './types.js';

/** True iff any message in the request carries an image content part (Req 2.8). */
export function requestHasImageInput(req: ChatRequest): boolean {
  return req.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
}

/**
 * Assert that a chat request is compatible with `model`'s capabilities (Req 2.8).
 *
 * Image attachments require {@link ModelInfo.supportsVision}; a chat request
 * with images routed to a non-vision model throws
 * {@link UnsupportedModelCapabilityError}.
 */
export function assertChatCapability(model: ModelInfo, req: ChatRequest): void {
  if (requestHasImageInput(req) && !model.supportsVision) {
    throw new UnsupportedModelCapabilityError(
      model.id,
      'vision',
      `model "${model.id}" does not support image (vision) input`,
    );
  }
}

/**
 * Assert that `model` can serve image generation (Req 2.9).
 *
 * Only image-modality models accept generation requests; anything else throws
 * {@link UnsupportedModelCapabilityError}.
 */
export function assertImageGenerationCapability(model: ModelInfo): void {
  if (model.modality !== 'image') {
    throw new UnsupportedModelCapabilityError(
      model.id,
      'image_generation',
      `model "${model.id}" (modality "${model.modality}") does not support image generation`,
    );
  }
}
