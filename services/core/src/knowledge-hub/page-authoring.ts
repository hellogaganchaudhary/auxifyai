/**
 * The default, model-free {@link PageAuthoringModel} (Req 26.7).
 *
 * {@link DeterministicPageAuthoringModel} is the model-free authoring seam the
 * Knowledge_Hub_Service composes by default so AI-authoring's accept/reject
 * lifecycle is fully testable without a model: it produces a deterministic draft
 * from the current content and the instruction (treating the instruction as the
 * new body when it is non-empty, otherwise echoing the current content). A
 * production deployment injects a {@link PageAuthoringModel} backed by the
 * Chat_Service that interprets the instruction as a natural-language change
 * request — without changing the service or its accept/reject flow.
 */

import type { PageAuthoringModel, RichContent } from './types.js';

/**
 * A deterministic {@link PageAuthoringModel} that produces a draft without a
 * model (Req 26.7).
 *
 * The produced draft preserves the current content's {@link RichContent.format}
 * and uses the trimmed instruction as the new body when one is supplied;
 * otherwise it returns the current content unchanged. The draft is never saved
 * by `aiAuthor` — it is returned for the user to accept or reject.
 */
export class DeterministicPageAuthoringModel implements PageAuthoringModel {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract
  async author(input: {
    current: RichContent;
    title: string;
    instruction: string;
  }): Promise<RichContent> {
    const instruction = input.instruction.trim();
    if (instruction.length === 0) {
      return { format: input.current.format, text: input.current.text };
    }
    return { format: input.current.format, text: instruction };
  }
}
