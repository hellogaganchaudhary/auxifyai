/**
 * Input_Processor (Req 7).
 *
 * Turns the many ways a user supplies context into attachments and message
 * context, enforcing the platform's rich-input rules:
 *
 *  - {@link InputProcessor.attachFile} — accept image/PDF/CSV/spreadsheet/code
 *    files and associate each with the message (Req 7.1), rejecting oversized
 *    files (Req 7.7) and over-the-limit attachment counts (Req 7.8).
 *  - {@link InputProcessor.transcribeVoice} — convert speech to text via the
 *    injected {@link SpeechToText} port (Req 7.2).
 *  - {@link InputProcessor.attachPastedImage} — attach a clipboard image
 *    (Req 7.3).
 *  - {@link InputProcessor.attachDropped} — attach a dragged file or URL
 *    (Req 7.4).
 *  - {@link InputProcessor.previewUrl} — fetch a preview and offer a summary of
 *    a pasted URL via the injected {@link UrlFetcher} + {@link Summarizer}
 *    ports (Req 7.5).
 *  - {@link InputProcessor.resolveMention} — resolve an `@`-mention to a team
 *    member, document, knowledge page, or project via the injected {@link
 *    MentionResolver} port and attach the referenced resource to the message
 *    context (Req 7.6).
 *
 * Every external capability is an injected port, so the processor is pure
 * orchestration: validation, classification, limit enforcement, and attachment
 * assembly. The 100 MB per-file limit (Req 7.7) and the 10-attachment
 * per-message limit (Req 7.8) are enforced consistently across every attach
 * path against the shared {@link AttachmentStore} count.
 */

import { randomUUID } from 'node:crypto';

import { classifyFile } from './file-types.js';
import {
  AttachmentCountError,
  FileSizeLimitError,
  MentionNotFoundError,
  UnsupportedFileTypeError,
} from './errors.js';
import { MAX_ATTACHMENTS, MAX_FILE_BYTES } from './limits.js';
import type {
  Attachment,
  AttachmentStore,
  AudioInput,
  DroppedContent,
  MentionResolver,
  MentionTarget,
  SpeechToText,
  Summarizer,
  UploadedFile,
  UrlFetcher,
  UrlPreview,
} from './types.js';

/** A unique attachment-id source, injectable for deterministic tests. */
export interface AttachmentIdGenerator {
  /** Return a new unique attachment id. */
  (): string;
}

/**
 * Construction-time dependencies for the {@link InputProcessor}.
 *
 * The four capability ports ({@link speechToText}, {@link urlFetcher}, {@link
 * summarizer}, {@link mentionResolver}) and the {@link attachmentStore} are
 * required; only the {@link idGenerator} has a default (`crypto.randomUUID`).
 * Requiring the ports keeps the processor honest — it never silently no-ops a
 * capability — while letting tests inject fakes.
 */
export interface InputProcessorOptions {
  /** Persists attachment bytes and tracks per-message counts (Req 7.1, 7.8). */
  attachmentStore: AttachmentStore;
  /** Converts speech to text (Req 7.2). */
  speechToText: SpeechToText;
  /** Fetches a URL preview (Req 7.5). */
  urlFetcher: UrlFetcher;
  /** Summarizes a fetched page (Req 7.5). */
  summarizer: Summarizer;
  /** Resolves an `@`-mention to a target (Req 7.6). */
  mentionResolver: MentionResolver;
  /** Attachment id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: AttachmentIdGenerator;
}

/** The fixed display name used for a clipboard-pasted image attachment (Req 7.3). */
const PASTED_IMAGE_NAME = 'pasted-image';

/**
 * The concrete Input_Processor. Construct it with the capability ports and an
 * {@link AttachmentStore}; all methods are async and reject with typed errors
 * on a violated rule.
 */
export class InputProcessor {
  private readonly store: AttachmentStore;
  private readonly speechToText: SpeechToText;
  private readonly urlFetcher: UrlFetcher;
  private readonly summarizer: Summarizer;
  private readonly mentionResolver: MentionResolver;
  private readonly newId: AttachmentIdGenerator;

  constructor(options: InputProcessorOptions) {
    this.store = options.attachmentStore;
    this.speechToText = options.speechToText;
    this.urlFetcher = options.urlFetcher;
    this.summarizer = options.summarizer;
    this.mentionResolver = options.mentionResolver;
    this.newId = options.idGenerator ?? ((): string => randomUUID());
  }

  /**
   * Attach a file to a message (Req 7.1).
   *
   * Accepts image, PDF, CSV, spreadsheet, and code file types; rejects any
   * other type with an {@link UnsupportedFileTypeError}. Enforces the 100 MB
   * per-file limit (Req 7.7) and the 10-attachment per-message limit (Req 7.8)
   * before persisting.
   *
   * @param messageId The message to associate the attachment with.
   * @param file The uploaded file.
   * @returns The created {@link Attachment}.
   * @throws {FileSizeLimitError} When the file exceeds {@link MAX_FILE_BYTES}.
   * @throws {UnsupportedFileTypeError} When the file type is not accepted.
   * @throws {AttachmentCountError} When the message already holds {@link MAX_ATTACHMENTS}.
   */
  async attachFile(messageId: string, file: UploadedFile): Promise<Attachment> {
    this.assertWithinSizeLimit(file);

    const kind = classifyFile(file);
    if (kind === null) {
      throw new UnsupportedFileTypeError(file.fileName, file.contentType);
    }

    await this.assertCapacity(messageId);

    const attachment: Attachment = {
      id: this.newId(),
      messageId,
      kind,
      name: file.fileName,
      sizeBytes: file.sizeBytes,
      ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
    };
    return this.persist(attachment, file.bytes);
  }

  /**
   * Convert a captured voice clip to text and return the transcript (Req 7.2).
   *
   * The transcription itself is delegated to the injected {@link SpeechToText}
   * port; the processor returns the text the caller places into the message
   * input.
   *
   * @param audio The captured voice input.
   * @returns The transcribed text.
   */
  async transcribeVoice(audio: AudioInput): Promise<string> {
    return this.speechToText.transcribe(audio);
  }

  /**
   * Attach a clipboard-pasted image to a message (Req 7.3).
   *
   * The pasted image is classified as an `image` attachment. Enforces the
   * 100 MB size limit (Req 7.7) and the 10-attachment limit (Req 7.8).
   *
   * @param messageId The message to associate the attachment with.
   * @param image The pasted image bytes.
   * @param contentType The image MIME type, when known (defaults to `image/png`).
   * @returns The created {@link Attachment}.
   */
  async attachPastedImage(
    messageId: string,
    image: Uint8Array,
    contentType = 'image/png',
  ): Promise<Attachment> {
    if (image.byteLength > MAX_FILE_BYTES) {
      throw new FileSizeLimitError(image.byteLength, PASTED_IMAGE_NAME);
    }
    await this.assertCapacity(messageId);

    const attachment: Attachment = {
      id: this.newId(),
      messageId,
      kind: 'image',
      name: PASTED_IMAGE_NAME,
      contentType,
      sizeBytes: image.byteLength,
    };
    return this.persist(attachment, image);
  }

  /**
   * Attach content dragged-and-dropped into the chat area (Req 7.4).
   *
   * A dropped file is classified and attached exactly like {@link attachFile}
   * (subject to the size and type rules); a dropped URL is attached as a `url`
   * attachment. Exactly one of `file`/`url` must be present. The 10-attachment
   * limit (Req 7.8) applies to both cases.
   *
   * @param messageId The message to associate the attachment with.
   * @param dropped The dropped file or URL.
   * @returns The created {@link Attachment}.
   * @throws {TypeError} When neither (or both) of `file`/`url` is provided.
   */
  async attachDropped(messageId: string, dropped: DroppedContent): Promise<Attachment> {
    const hasFile = dropped.file !== undefined;
    const hasUrl = dropped.url !== undefined;
    if (hasFile === hasUrl) {
      throw new TypeError('attachDropped requires exactly one of { file } or { url }');
    }

    if (dropped.file !== undefined) {
      return this.attachFile(messageId, dropped.file);
    }

    const url = normalizeUrl(dropped.url!);
    await this.assertCapacity(messageId);
    const attachment: Attachment = {
      id: this.newId(),
      messageId,
      kind: 'url',
      name: url,
      url,
    };
    return this.persist(attachment);
  }

  /**
   * Fetch a preview of a pasted URL and offer a summary of the linked page
   * (Req 7.5).
   *
   * Fetching is delegated to the injected {@link UrlFetcher} and summarizing to
   * the injected {@link Summarizer}; the processor validates the URL, derives a
   * fallback site name from its host, and assembles the {@link UrlPreview}.
   *
   * @param url The pasted URL to preview.
   * @returns The assembled preview, including the offered summary.
   * @throws {TypeError} When the URL is not a valid http(s) URL.
   */
  async previewUrl(url: string): Promise<UrlPreview> {
    const normalized = normalizeUrl(url);
    const page = await this.urlFetcher.fetch(normalized);
    const summary = await this.summarizer.summarize(page);

    const siteName = page.siteName ?? hostOf(normalized);
    const preview: UrlPreview = {
      url: page.url || normalized,
      summary,
      ...(page.title !== undefined ? { title: page.title } : {}),
      ...(page.description !== undefined ? { description: page.description } : {}),
      ...(siteName !== undefined ? { siteName } : {}),
      ...(page.imageUrl !== undefined ? { imageUrl: page.imageUrl } : {}),
    };
    return preview;
  }

  /**
   * Resolve an `@`-mention to a team member, document, knowledge page, or
   * project so the referenced resource can be attached to the message context
   * (Req 7.6).
   *
   * Resolution is delegated to the injected {@link MentionResolver}. An
   * unresolved token fails closed with a {@link MentionNotFoundError} rather
   * than attaching an unverified reference.
   *
   * @param token The mention text, with or without a leading `@`.
   * @returns The resolved {@link MentionTarget}.
   * @throws {MentionNotFoundError} When nothing matches the token.
   */
  async resolveMention(token: string): Promise<MentionTarget> {
    const normalized = token.startsWith('@') ? token.slice(1) : token;
    const trimmed = normalized.trim();
    if (trimmed.length === 0) {
      throw new MentionNotFoundError(normalized);
    }

    const target = await this.mentionResolver.resolve(trimmed);
    if (target === null) {
      throw new MentionNotFoundError(trimmed);
    }
    return target;
  }

  /** Reject a file that exceeds the 100 MB per-file limit (Req 7.7). */
  private assertWithinSizeLimit(file: UploadedFile): void {
    if (file.sizeBytes > MAX_FILE_BYTES) {
      throw new FileSizeLimitError(file.sizeBytes, file.fileName);
    }
  }

  /**
   * Reject a new attachment when the message already holds the maximum
   * (Req 7.8). Checked against the shared {@link AttachmentStore} count so the
   * limit holds across every attach path.
   */
  private async assertCapacity(messageId: string): Promise<void> {
    const current = await this.store.countForMessage(messageId);
    if (current >= MAX_ATTACHMENTS) {
      throw new AttachmentCountError(messageId, current);
    }
  }

  /** Persist the attachment bytes and record the attachment, returning it. */
  private async persist(attachment: Attachment, bytes?: Uint8Array): Promise<Attachment> {
    const storageKey = await this.store.save(attachment, bytes);
    return storageKey !== undefined ? { ...attachment, storageKey } : attachment;
  }
}

/** Validate and normalize a URL, accepting only http(s) schemes. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TypeError(`Invalid URL: "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Unsupported URL scheme "${parsed.protocol}" (expected http or https)`);
  }
  return parsed.toString();
}

/** Derive the host (e.g. `example.com`) from a URL, or `undefined` when not parseable. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
