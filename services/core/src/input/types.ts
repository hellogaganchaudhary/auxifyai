/**
 * Domain records and injectable ports for the Input_Processor (Req 7).
 *
 * The Input_Processor turns the many ways a user supplies context — attached
 * files, voice, pasted images, dragged content, pasted URLs, and `@`-mentions
 * — into attachments and context associated with a message. Every external
 * capability it cannot perform purely (speech-to-text, URL fetching,
 * summarizing, mention resolution, and attachment persistence/counting) is
 * modelled here as a narrow port so the processor is fully unit-testable with
 * fakes and has no hard dependency on a network, a model, or a database.
 */

import type { ResourceRef, ResourceType } from '@auxify/types';

/**
 * The accepted attachment categories (Req 7.1).
 *
 * Req 7.1 enumerates the file *families* the Input_Processor accepts: images,
 * PDFs, CSVs, spreadsheets, and code files. A `url` kind is added for the
 * dragged/dropped URL case (Req 7.4); a pasted-image attachment is classified
 * as `image` (Req 7.3).
 */
export type AttachmentKind = 'image' | 'pdf' | 'csv' | 'spreadsheet' | 'code' | 'url';

/** All {@link AttachmentKind} values, for iteration, validation, and tests. */
export const ATTACHMENT_KINDS: readonly AttachmentKind[] = [
  'image',
  'pdf',
  'csv',
  'spreadsheet',
  'code',
  'url',
] as const;

/**
 * A file supplied by the user for attachment (Req 7.1).
 *
 * The `sizeBytes` is what the 100 MB limit is checked against (Req 7.7); the
 * `contentType` (MIME) and `fileName` together determine the {@link
 * AttachmentKind}. `bytes` is optional so a caller can validate metadata (size,
 * type) before streaming the payload to storage.
 */
export interface UploadedFile {
  /** The original file name, including extension (e.g. `report.pdf`). */
  fileName: string;
  /** The declared MIME type (e.g. `application/pdf`), when known. */
  contentType?: string;
  /** The file size in bytes — checked against {@link MAX_FILE_BYTES} (Req 7.7). */
  sizeBytes: number;
  /** The raw file payload, when available at attach time. */
  bytes?: Uint8Array;
}

/**
 * An attachment associated with a message (Req 7.1, 7.3, 7.4).
 *
 * Produced by every attach entry point; the `kind` records how the content was
 * classified, `messageId` ties it to its message, and `storageKey` (when set)
 * is the Object_Store key the {@link AttachmentStore} persisted the bytes
 * under.
 */
export interface Attachment {
  /** The attachment's stable unique id. */
  id: string;
  /** The message this attachment belongs to. */
  messageId: string;
  /** The classified attachment kind. */
  kind: AttachmentKind;
  /** A display name for the attachment (file name, `pasted-image`, or the URL). */
  name: string;
  /** The declared MIME type, when known. */
  contentType?: string;
  /** The size in bytes, when the attachment has a byte payload. */
  sizeBytes?: number;
  /** The Object_Store key the bytes were persisted under, when stored. */
  storageKey?: string;
  /** For a dropped/pasted URL attachment, the URL itself. */
  url?: string;
}

/**
 * A captured voice clip to be transcribed (Req 7.2).
 *
 * The audio payload is kept opaque (`bytes` + `contentType`) because
 * transcription is delegated to the injected {@link SpeechToText} port; the
 * processor never inspects the audio itself.
 */
export interface AudioInput {
  /** The raw audio payload (e.g. WAV/MP3 bytes). */
  bytes: Uint8Array;
  /** The audio MIME type (e.g. `audio/wav`), when known. */
  contentType?: string;
  /** The BCP-47 language hint for the transcriber, when known. */
  language?: string;
}

/**
 * Content dragged-and-dropped into the chat area (Req 7.4).
 *
 * A drop is either a file or a URL; exactly one of {@link file}/{@link url} is
 * provided. The processor classifies and attaches whichever is present.
 */
export interface DroppedContent {
  /** A dropped file, when the drop carried a file. */
  file?: UploadedFile;
  /** A dropped URL, when the drop carried a link. */
  url?: string;
}

/**
 * A preview of a pasted URL, with an offered summary (Req 7.5).
 *
 * Built from the {@link UrlFetcher} result (title/description/site) plus the
 * {@link Summarizer} output (`summary`). Surfaced to the user so they can
 * decide whether to attach or summarize the linked page.
 */
export interface UrlPreview {
  /** The previewed URL. */
  url: string;
  /** The page title, when the fetched page exposed one. */
  title?: string;
  /** The page description / meta summary, when available. */
  description?: string;
  /** The site / host name (e.g. `example.com`), when derivable. */
  siteName?: string;
  /** A preview image URL (e.g. Open Graph image), when available. */
  imageUrl?: string;
  /** The offered summary of the linked page (Req 7.5). */
  summary: string;
}

/** The raw result of fetching a URL for preview, as returned by a {@link UrlFetcher}. */
export interface FetchedPage {
  /** The (possibly redirected) final URL. */
  url: string;
  /** The page title, when present. */
  title?: string;
  /** The page description / meta summary, when present. */
  description?: string;
  /** The site / host name, when present. */
  siteName?: string;
  /** A preview image URL, when present. */
  imageUrl?: string;
  /** The extracted main text content used to build a summary. */
  content: string;
}

/**
 * The kinds of resource an `@`-mention can resolve to (Req 7.6).
 *
 * Constrained to the {@link ResourceType} subset the requirement names: a team
 * member (`user`), a document, a knowledge page, or a project.
 */
export type MentionTargetType = Extract<
  ResourceType,
  'user' | 'document' | 'knowledge_page' | 'project'
>;

/** All {@link MentionTargetType} values, for iteration, validation, and tests. */
export const MENTION_TARGET_TYPES: readonly MentionTargetType[] = [
  'user',
  'document',
  'knowledge_page',
  'project',
] as const;

/**
 * A resolved `@`-mention (Req 7.6).
 *
 * Carries the matched display label and a tenant-qualified {@link ResourceRef}
 * (whose `type` is one of {@link MentionTargetType}) so the referenced resource
 * can be attached to the message context and later authorized by
 * Access_Control.
 */
export interface MentionTarget {
  /** The kind of resource the mention resolved to. */
  type: MentionTargetType;
  /** A human-readable label for the resolved target (name/title). */
  label: string;
  /** The tenant-qualified reference to the resolved resource. */
  ref: ResourceRef;
}

/**
 * The port that converts speech to text (Req 7.2).
 *
 * Modelling transcription as a port keeps the Input_Processor independent of
 * any concrete speech model or service, and lets the unit tests inject a fake
 * that returns deterministic text without real audio.
 */
export interface SpeechToText {
  /**
   * Transcribe a captured audio clip to text.
   *
   * @param audio The captured voice input.
   * @returns The transcribed text.
   */
  transcribe(audio: AudioInput): Promise<string>;
}

/**
 * The port that fetches a URL for preview (Req 7.5).
 *
 * Modelling fetching as a port keeps the Input_Processor independent of the
 * network (and of the Web_Scraper, task 13.x), and lets the unit tests inject a
 * fake page.
 */
export interface UrlFetcher {
  /**
   * Fetch a page's preview metadata and main content.
   *
   * @param url The URL to fetch.
   * @returns The fetched page.
   */
  fetch(url: string): Promise<FetchedPage>;
}

/**
 * The port that summarizes fetched page content (Req 7.5).
 *
 * Kept separate from the {@link UrlFetcher} so the summarization model can be
 * swapped independently and faked in tests.
 */
export interface Summarizer {
  /**
   * Summarize a fetched page into a short offered summary.
   *
   * @param page The fetched page to summarize.
   * @returns The summary text.
   */
  summarize(page: FetchedPage): Promise<string>;
}

/**
 * The port that resolves an `@`-mention token to a target (Req 7.6).
 *
 * Modelling resolution as a port lets the Input_Processor stay decoupled from
 * the Tenancy_Service / Knowledge / Document repositories that actually back
 * the lookup, and lets the unit tests inject deterministic resolutions. A token
 * that matches nothing resolves to `null`, which the processor turns into a
 * typed not-found rejection.
 */
export interface MentionResolver {
  /**
   * Resolve a mention token (the text after `@`) to a target, or `null` when
   * nothing matches within the caller's scope.
   *
   * @param token The mention token (without the leading `@`).
   * @returns The resolved target, or `null` when unresolved.
   */
  resolve(token: string): Promise<MentionTarget | null>;
}

/**
 * The port that persists attachment bytes and tracks the per-message
 * attachment count (Req 7.1, 7.8).
 *
 * The Input_Processor depends on this seam rather than the Object_Store /
 * message repository directly, so the 10-attachment limit (Req 7.8) is enforced
 * against a real, shared count across every attach path while the tests use an
 * in-memory implementation. All methods are scoped by `messageId`.
 */
export interface AttachmentStore {
  /**
   * Persist an attachment's bytes (when present) and record it against its
   * message, returning the Object_Store key the bytes were stored under (or
   * `undefined` for a byte-less attachment such as a URL).
   *
   * @param attachment The attachment to persist.
   * @param bytes The raw payload to store, when available.
   */
  save(attachment: Attachment, bytes?: Uint8Array): Promise<string | undefined>;

  /**
   * Return how many attachments are currently associated with the message.
   *
   * @param messageId The message to count attachments for.
   */
  countForMessage(messageId: string): Promise<number>;
}
