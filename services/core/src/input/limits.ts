/**
 * Input_Processor hard limits (Req 7.7, 7.8).
 *
 * These two constants are the single source of truth for the rich-input
 * constraints the requirements mandate, shared by the {@link
 * import('./input-processor.js').InputProcessor} and by the limit unit tests
 * (task 8.12):
 *
 *  - {@link MAX_FILE_BYTES} — an individual attached file may be at most
 *    100 MB; a larger file is rejected with a {@link
 *    import('./errors.js').FileSizeLimitError} (Req 7.7).
 *  - {@link MAX_ATTACHMENTS} — a single message may carry at most 10
 *    attachments; an additional attachment is rejected with an {@link
 *    import('./errors.js').AttachmentCountError} (Req 7.8).
 *
 * Keeping them here (rather than inline) means the limit and the error that
 * enforces it can never drift apart, and the tests assert against the same
 * value the processor enforces.
 */

/**
 * The maximum size, in bytes, of a single attached file (100 MB, Req 7.7).
 *
 * Computed as `100 * 1024 * 1024` (binary megabytes) so the boundary is exact
 * and stable. A file whose `sizeBytes` is strictly greater than this is
 * rejected; a file exactly at the limit is accepted.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * The maximum number of attachments a single message may carry (10, Req 7.8).
 *
 * The count is enforced across every attachment entry point — {@link
 * import('./input-processor.js').InputProcessor.attachFile},
 * {@link import('./input-processor.js').InputProcessor.attachPastedImage}, and
 * {@link import('./input-processor.js').InputProcessor.attachDropped} — so the
 * 11th attachment is rejected regardless of how it arrives.
 */
export const MAX_ATTACHMENTS = 10;
