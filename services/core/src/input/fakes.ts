/**
 * Test fakes for the Input_Processor (Req 7).
 *
 * Each injectable port has a small, deterministic in-memory implementation so
 * the processor's orchestration, classification, and limit enforcement can be
 * unit-tested without real audio, network, models, or a database:
 *
 *  - {@link InMemoryAttachmentStore} persists attachments in a map and tracks
 *    the per-message count the 10-attachment limit checks against (Req 7.8).
 *  - {@link FakeSpeechToText} returns a canned transcript (Req 7.2).
 *  - {@link FakeUrlFetcher} returns a canned page (Req 7.5).
 *  - {@link FakeSummarizer} returns a deterministic summary derived from the
 *    page (Req 7.5).
 *  - {@link FakeMentionResolver} resolves from a seeded token→target map, and
 *    returns `null` for an unknown token (Req 7.6).
 */

import type {
  Attachment,
  AttachmentStore,
  AudioInput,
  FetchedPage,
  MentionResolver,
  MentionTarget,
  SpeechToText,
  Summarizer,
  UrlFetcher,
} from './types.js';

/**
 * An in-memory {@link AttachmentStore}: it stores each saved attachment and
 * counts attachments per message. `save` returns a deterministic storage key
 * for byte-bearing attachments and `undefined` for byte-less ones (e.g. URLs).
 */
export class InMemoryAttachmentStore implements AttachmentStore {
  /** Every saved attachment, in save order. */
  readonly saved: Array<{ attachment: Attachment; bytes?: Uint8Array }> = [];
  private readonly counts = new Map<string, number>();
  private keyN = 0;

  async save(attachment: Attachment, bytes?: Uint8Array): Promise<string | undefined> {
    this.saved.push({ attachment, ...(bytes !== undefined ? { bytes } : {}) });
    this.counts.set(attachment.messageId, (this.counts.get(attachment.messageId) ?? 0) + 1);
    if (bytes === undefined) {
      return undefined;
    }
    this.keyN += 1;
    return `attachments/${attachment.messageId}/${this.keyN}`;
  }

  async countForMessage(messageId: string): Promise<number> {
    return this.counts.get(messageId) ?? 0;
  }

  /** Pre-seed a message's attachment count (e.g. to drive the limit boundary). */
  seedCount(messageId: string, count: number): void {
    this.counts.set(messageId, count);
  }
}

/** A {@link SpeechToText} fake returning a fixed transcript and capturing calls. */
export class FakeSpeechToText implements SpeechToText {
  /** Every audio clip passed to {@link transcribe}. */
  readonly calls: AudioInput[] = [];

  constructor(private readonly transcript = 'transcribed text') {}

  async transcribe(audio: AudioInput): Promise<string> {
    this.calls.push(audio);
    return this.transcript;
  }
}

/** A {@link UrlFetcher} fake returning a canned {@link FetchedPage}. */
export class FakeUrlFetcher implements UrlFetcher {
  /** Every URL passed to {@link fetch}. */
  readonly calls: string[] = [];

  constructor(private readonly page?: Partial<FetchedPage>) {}

  async fetch(url: string): Promise<FetchedPage> {
    this.calls.push(url);
    return {
      url: this.page?.url ?? url,
      content: this.page?.content ?? 'page content',
      ...(this.page?.title !== undefined ? { title: this.page.title } : {}),
      ...(this.page?.description !== undefined ? { description: this.page.description } : {}),
      ...(this.page?.siteName !== undefined ? { siteName: this.page.siteName } : {}),
      ...(this.page?.imageUrl !== undefined ? { imageUrl: this.page.imageUrl } : {}),
    };
  }
}

/** A {@link Summarizer} fake producing a deterministic summary from the page. */
export class FakeSummarizer implements Summarizer {
  /** Every page passed to {@link summarize}. */
  readonly calls: FetchedPage[] = [];

  async summarize(page: FetchedPage): Promise<string> {
    this.calls.push(page);
    return `Summary: ${page.title ?? page.url}`;
  }
}

/** A {@link MentionResolver} fake backed by a seeded token→target map. */
export class FakeMentionResolver implements MentionResolver {
  private readonly targets = new Map<string, MentionTarget>();

  constructor(seed: Record<string, MentionTarget> = {}) {
    for (const [token, target] of Object.entries(seed)) {
      this.targets.set(token, target);
    }
  }

  /** Seed (or replace) the target a token resolves to. */
  set(token: string, target: MentionTarget): void {
    this.targets.set(token, target);
  }

  async resolve(token: string): Promise<MentionTarget | null> {
    return this.targets.get(token) ?? null;
  }
}
