/**
 * Input_Processor (Req 7).
 *
 * The Input_Processor handles the rich ways a user provides context to a
 * message and enforces the platform's input limits:
 *
 *   - {@link InputProcessor.attachFile} — accept image/PDF/CSV/spreadsheet/code
 *     files and associate each with the message (Req 7.1).
 *   - {@link InputProcessor.transcribeVoice} — convert speech to text via the
 *     injectable {@link SpeechToText} port (Req 7.2).
 *   - {@link InputProcessor.attachPastedImage} — attach a clipboard image
 *     (Req 7.3).
 *   - {@link InputProcessor.attachDropped} — attach a dragged file or URL
 *     (Req 7.4).
 *   - {@link InputProcessor.previewUrl} — fetch a preview and offer a summary
 *     of a pasted URL via the injectable {@link UrlFetcher} + {@link Summarizer}
 *     ports (Req 7.5).
 *   - {@link InputProcessor.resolveMention} — resolve an `@`-mention to a team
 *     member, document, knowledge page, or project via the injectable {@link
 *     MentionResolver} port (Req 7.6).
 *
 * The hard limits are enforced with typed errors across every attach path: a
 * file over {@link MAX_FILE_BYTES} (100 MB) raises a {@link FileSizeLimitError}
 * (Req 7.7), and an 11th attachment raises an {@link AttachmentCountError}
 * (Req 7.8). Every external capability is an injectable port so the processor
 * is fully unit-testable with the fakes in `./fakes.js`.
 */

export {
  InputProcessor,
  type InputProcessorOptions,
  type AttachmentIdGenerator,
} from './input-processor.js';

export { MAX_FILE_BYTES, MAX_ATTACHMENTS } from './limits.js';

export {
  FileSizeLimitError,
  AttachmentCountError,
  UnsupportedFileTypeError,
  MentionNotFoundError,
  FILE_SIZE_LIMIT_CODE,
  ATTACHMENT_COUNT_CODE,
  UNSUPPORTED_FILE_TYPE_CODE,
  MENTION_NOT_FOUND_CODE,
} from './errors.js';

export { classifyFile } from './file-types.js';

export {
  ATTACHMENT_KINDS,
  MENTION_TARGET_TYPES,
  type AttachmentKind,
  type UploadedFile,
  type Attachment,
  type AudioInput,
  type DroppedContent,
  type UrlPreview,
  type FetchedPage,
  type MentionTargetType,
  type MentionTarget,
  type SpeechToText,
  type UrlFetcher,
  type Summarizer,
  type MentionResolver,
  type AttachmentStore,
} from './types.js';
