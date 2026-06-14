/**
 * Client-side conversation persistence.
 *
 * Chats are saved in the browser's `localStorage` so conversations survive
 * reloads and the user can switch between them (ChatGPT-style history). This is
 * deliberately a local store — no backend persistence is required for the chat
 * product to be useful — and it is pure/DOM-guarded so it is safe during SSR.
 *
 * When server-side conversation storage lands, these functions can be swapped
 * for API calls without changing the chat UI.
 */

import type { ChatMessage } from '@auxify/types';
import type { GeneratedFile } from './chat-client';

/** What kind of content an assistant turn produced. */
export type MessageKind = 'text' | 'image' | 'video' | 'file' | 'research';

/** A discovered research source (favicon/title/domain rendered in the UI). */
export interface ResearchSourceItem {
  index: number;
  title: string;
  url: string;
}

/** One entry in the research activity timeline. */
export interface ResearchActivity {
  phase: string;
  message: string;
}

/** The premium research state shown above a deep-research report. */
export interface ResearchState {
  /** Whether the run is still in progress. */
  running: boolean;
  /** The current phase label (e.g. `writing`, `searched`). */
  phase: string;
  /** The activity timeline (deduplicated, newest appended). */
  activity: ResearchActivity[];
  /** Planned search queries. */
  queries: string[];
  /** Discovered sources. */
  sources: ResearchSourceItem[];
  /** Section outline (exhaustive mode). */
  outline: string[];
  /** Current section index (1-based) being written. */
  current: number;
  /** Total sections. */
  total: number;
  /** Rolling report character count. */
  chars: number;
  /** Rolling report word count. */
  words: number;
  /** Whether this was the exhaustive ("very deep") mode. */
  exhaustive: boolean;
  /** An error message if the run failed. */
  error?: string;
}

/** A stored chat turn (user or assistant) with the model that produced it. */
export interface StoredMessage {
  /** Stable message id. */
  id: string;
  /** Author role. */
  role: 'user' | 'assistant';
  /** Plain-text message content. */
  content: string;
  /** The model id that produced an assistant message. */
  model?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Input (prompt) tokens consumed by an assistant message. */
  inputTokens?: number;
  /** Output (completion) tokens produced by an assistant message. */
  outputTokens?: number;
  /** Cost of producing an assistant message, in the accounting currency. */
  cost?: number;
  /** Names of files attached to a user message (for display). */
  attachments?: string[];
  /** Generated images (base64 data URLs) on an assistant message. */
  images?: string[];
  /** Generated videos (base64 data URLs) on an assistant message. */
  videos?: string[];
  /** Generated downloadable files on an assistant message. */
  files?: GeneratedFile[];
  /**
   * A PDF rendering of the first generated file, used for in-browser preview
   * when the file itself is not a PDF (e.g. designed PPTX/DOCX).
   */
  filePreview?: GeneratedFile;
  /** The kind of assistant output (text / image / video). */
  kind?: MessageKind;
  /**
   * Live research state for a `research` message: the activity log, discovered
   * sources, and rolling stats. Persisted so a finished report keeps its
   * premium research header (process timeline + sources) on reload.
   */
  research?: ResearchState;
  /**
   * Web-search sources cited by this assistant message (drives clickable
   * citation chips and the premium "Sources" card row under the answer).
   */
  sources?: ResearchSourceItem[];
  /**
   * The exact prompt used to generate an image/video. Stored so the model can
   * "remember" what it created and so the user can regenerate or reference it.
   */
  genPrompt?: string;
  /**
   * Live generation progress for an in-flight image/video/file message. Drives
   * the animated "creating…" graphic (see {@link GenerationProgress}); cleared
   * once the final media/file is attached.
   */
  generating?: {
    /** What is being produced. */
    kind: 'image' | 'video' | 'file';
    /** The current human-readable phase, e.g. "Painting details". */
    label: string;
    /** Progress 0–100. */
    pct: number;
  };
}

/** A saved conversation: its title, model, messages, and timestamps. */
export interface Conversation {
  /** Stable conversation id. */
  id: string;
  /** Human-readable title (auto-derived from the first user message). */
  title: string;
  /** The model id last used in this conversation. */
  modelId: string;
  /** The ordered messages, oldest first. */
  messages: StoredMessage[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp (drives recent-first ordering). */
  updatedAt: string;
}

/** The `localStorage` key the conversation list is persisted under. */
const STORAGE_KEY = 'auxify.conversations.v1';

/** Whether we are running in a browser with `localStorage` available. */
function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** A reasonably unique id without external dependencies. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Load all conversations, most-recently-updated first. */
export function loadConversations(): Conversation[] {
  if (!hasStorage()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...parsed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** Persist the full conversation list. */
export function saveConversations(conversations: Conversation[]): void {
  if (!hasStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Quota or privacy mode — silently skip persistence.
  }
}

/** Create a new, empty conversation for the given model. */
export function createConversation(modelId: string): Conversation {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: 'New chat',
    modelId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Derive a short title from the first user message. */
export function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    return 'New chat';
  }
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

/** Project stored messages into the wire `ChatMessage[]` history for the API. */
export function toChatHistory(messages: StoredMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => {
      // Surface generated media as part of the assistant's remembered turn so
      // the model knows what it previously produced (and can reference it).
      if (m.role === 'assistant' && m.kind === 'image' && m.genPrompt) {
        return { role: m.role, content: `[Generated an image with prompt: "${m.genPrompt}"]` };
      }
      if (m.role === 'assistant' && m.kind === 'video' && m.genPrompt) {
        return { role: m.role, content: `[Generated a video with prompt: "${m.genPrompt}"]` };
      }
      if (m.role === 'assistant' && m.kind === 'file' && m.files && m.files.length > 0) {
        return { role: m.role, content: `[Generated files: ${m.files.map((f) => f.filename).join(', ')}]` };
      }
      if (m.role === 'assistant' && m.kind === 'research') {
        return { role: m.role, content: `[Completed a deep research report]\n${m.content.slice(0, 4000)}` };
      }
      return { role: m.role, content: m.content };
    });
}

/**
 * Build a compact "memory" note summarizing the media generated so far in the
 * conversation, so the model can resolve references like "the previous image"
 * or "regenerate that". Returns an empty string when nothing was generated.
 */
export function buildMediaMemory(messages: StoredMessage[]): string {
  const media = messages
    .filter((m) => m.role === 'assistant' && (m.kind === 'image' || m.kind === 'video') && m.genPrompt)
    .map((m, i) => `${i + 1}. ${m.kind} — "${m.genPrompt}"`);
  if (media.length === 0) {
    return '';
  }
  return (
    'Media generated earlier in this conversation (most recent last):\n' +
    media.join('\n') +
    '\nIf the user refers to a previous image/video (e.g. "the previous one", "that image"), use the matching prompt above as the basis.'
  );
}

/**
 * Find the most recent generated-media prompt in a conversation, for resolving
 * "regenerate the previous image/video" without a model round-trip when the
 * request is clearly a bare reference.
 */
export function lastGenPrompt(
  messages: StoredMessage[],
  kind: MessageKind,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.kind === kind && m.genPrompt) {
      return m.genPrompt;
    }
  }
  return undefined;
}
