'use client';

/**
 * Auxify chat — a context-aware, multimodal assistant.
 *
 * Layout: a left conversation history rail and a centered conversation column
 * with a floating composer. All controls live ON the composer (model picker +
 * a tools menu for image/video/web-search/voice + attachments) — there is no
 * separate settings panel.
 *
 * Context awareness: every turn sends the full conversation history plus a
 * "media memory" note (what images/videos were generated and with what prompt),
 * and image/video requests are resolved against that context so references like
 * "generate the previous image but at night" work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatContentPart, ModelInfo } from '@auxify/types';

import {
  listModels,
  getCapabilities,
  streamChat,
  webSearch,
  getAllKnowledge,
  completeText,
  extractFiles,
  generateFile,
  generateImage,
  enhanceImagePrompt,
  generateVideo,
  runDeepResearch,
  downloadGeneratedFile,
  resolveGenerationPrompt,
  getRealtimeWsUrl,
  prepareFile,
  generateDesignedDocument,
  renderDesignedFromMarkdown,
  DOC_THEMES,
  type Capabilities,
  type GeneratedFileFormat,
  type GeneratedFile,
  type DesignedFormat,
  type DocThemeId,
  type PreparedFile,
} from '@/lib/chat-client';
import {
  buildMediaMemory,
  createConversation,
  deriveTitle,
  loadConversations,
  newId,
  saveConversations,
  toChatHistory,
  type Conversation,
  type StoredMessage,
  type ResearchState,
} from '@/lib/conversations';
import {
  recordUsage,
  resolveCost,
  usageTotals,
  usageRows,
  formatTokens,
  formatCost,
  loadUsage,
  resetUsage,
  type ModelUsage,
} from '@/lib/usage';
import { useTheme } from '@/components/shell/ThemeProvider';
import { logout } from '@/lib/auth';
import { Markdown } from '@/components/Markdown';
import { BrandMark } from '@/components/brand/Logo';
import { downloadText } from '@/components/CodeBlock';
import { createZipBase64 } from '@/lib/zip';
import { buildBundleEntries } from '@/lib/research-bundle';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { KnowledgePanel } from '@/components/KnowledgePanel';
import { ResearchView } from '@/components/ResearchView';
import { SourceCards } from '@/components/SourceCards';
import { DocumentPreview, toPreviewTarget, type PreviewTarget } from '@/components/DocumentPreview';
import { GenerationProgress } from '@/components/GenerationProgress';
import { extractArtifacts, ARTIFACTS_PRIMER, VISUAL_PRIMER, type Artifact } from '@/lib/artifacts';

/** Composer mode: normal chat, media generation, file generation, or deep research. */
type Mode = 'text' | 'image' | 'video' | 'file' | 'research';

/**
 * Welcome-screen content modeled on the ChatGPT UI Kit "New chat" design
 * (Examples / Capabilities / Limitations columns). Example prompts are
 * clickable and send immediately.
 */
const WELCOME_EXAMPLES = [
  '"Create a board-ready PPTX on our 2026 AI strategy"',
  '"Run deep research on Azure AI Foundry vs Bedrock"',
  '"Turn this brief into a polished PDF and DOCX"',
];
const WELCOME_CAPABILITIES = [
  'Creates real PPTX, PDF, DOCX, XLSX, CSV, HTML, Markdown, and text files.',
  'Runs deep research: plans searches, reads sources, writes cited reports.',
  'Uses Claude, GPT, Foundry models, image/video generation, web search, files, and voice.',
];
const WELCOME_LIMITATIONS = [
  'Deep research depends on available web-search and scrape provider quotas.',
  'Generated files should be reviewed before external sharing.',
  'Model answers can still be wrong; verify important claims and numbers.',
];

/** Pick the best default chat model: first available, else first chat model. */
function pickDefaultModel(models: ModelInfo[]): string {
  const chat = models.filter((m) => m.modality === 'chat' || m.modality === 'reasoning');
  const available = chat.find((m) => m.available);
  return (available ?? chat[0] ?? models[0])?.id ?? '';
}

/** Output-length presets: a system directive + token ceiling for the model. */
const LENGTH_PRESETS: Record<
  'auto' | 'long' | 'max',
  { label: string; maxTokens?: number; directive?: string }
> = {
  auto: { label: 'Auto' },
  long: {
    label: 'Long',
    maxTokens: 16000,
    directive:
      'Produce a thorough, in-depth response with clear headings and well-structured sections. Fully develop each point with explanation, examples, and detail.',
  },
  max: {
    label: 'Max',
    maxTokens: 32000,
    directive:
      'Produce an exhaustive, comprehensive long-form response — the equivalent of many pages. Organize it as a complete document with a title, introduction, multiple detailed sections with descriptive headings, examples, and a conclusion. Never truncate or summarize prematurely. If the user asks for a specific number of pages or items, meet or exceed it.',
  },
};

const FILE_FORMATS: Array<{ format: GeneratedFileFormat; label: string }> = [
  { format: 'pptx', label: 'PowerPoint (.pptx)' },
  { format: 'pdf', label: 'PDF (.pdf)' },
  { format: 'docx', label: 'Word (.docx)' },
  { format: 'xlsx', label: 'Excel (.xlsx)' },
  { format: 'csv', label: 'CSV (.csv)' },
  { format: 'html', label: 'HTML (.html)' },
  { format: 'md', label: 'Markdown (.md)' },
  { format: 'txt', label: 'Text (.txt)' },
];

function fileLabel(format: GeneratedFileFormat): string {
  return FILE_FORMATS.find((f) => f.format === format)?.label ?? format;
}

/**
 * Character budget for injecting the FULL knowledge base into a model's
 * context. Derived from the model's token window (~4 chars/token), using ~55%
 * of it for knowledge and leaving the rest for the conversation + answer.
 * Bounded so a tiny window still gets something and a huge one stays sane.
 */
function knowledgeBudgetChars(maxTokens: number | undefined): number {
  const tokens = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 32_000;
  return Math.max(40_000, Math.min(3_000_000, Math.floor(tokens * 0.55 * 4)));
}

/** Format the full knowledge base as a single labeled context block. */
function formatFullKnowledge(sources: { title: string; kind: string; text: string }[]): string {
  // Label each document by its TITLE only (no "Source N"), so the model never
  // echoes bracketed tags like "[Source 1]" into its answer.
  return sources.map((s) => `### ${s.title}\n${s.text}`).join('\n\n');
}

/** The kinds of work that show a {@link GenerationProgress} surface. */
type GenKind = 'image' | 'video' | 'file';

/** A live generation-progress object stored on a message. */
interface GenState {
  kind: GenKind;
  label: string;
  pct: number;
}

/** Staged phase labels for image synthesis. */
const IMAGE_PHASES = [
  'Enhancing your prompt',
  'Composing the scene',
  'Sketching forms & layout',
  'Painting details',
  'Refining color & lighting',
  'Upscaling & sharpening',
];

/** Staged phase labels for designed-document generation. */
const DOC_PHASES = [
  'Planning the structure',
  'Researching & drafting',
  'Authoring sections',
  'Designing the layout',
  'Rendering pages',
];

/**
 * Drive a smooth, phase-aware progress animation for a long-running generation.
 *
 * The bar creeps toward `cap` on a timer (so the wait always feels alive) while
 * the caller pins meaningful phase labels/percentages at real milestones via
 * `setPhase`. Calling `finish` stops the timer; the caller then clears the
 * `generating` state and attaches the final result.
 */
function startStagedProgress(
  kind: GenKind,
  phases: string[],
  update: (gen: GenState) => void,
  opts: { cap?: number; intervalMs?: number; startPct?: number } = {},
): { setPhase: (label: string, pct?: number) => void; finish: () => void } {
  const cap = opts.cap ?? 92;
  const intervalMs = opts.intervalMs ?? 700;
  let pct = opts.startPct ?? 4;
  let label = phases[0] ?? 'Working';
  update({ kind, label, pct });
  const timer = setInterval(() => {
    pct = Math.min(cap, pct + Math.random() * 6 + 2);
    const idx = Math.min(phases.length - 1, Math.floor((pct / cap) * phases.length));
    label = phases[idx] ?? label;
    update({ kind, label, pct });
  }, intervalMs);
  return {
    setPhase: (nextLabel: string, nextPct?: number) => {
      label = nextLabel;
      if (nextPct !== undefined) pct = nextPct;
      update({ kind, label, pct });
    },
    finish: () => clearInterval(timer),
  };
}

export function ChatApp() {
  const { resolved, setPreference } = useTheme();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<Mode>('text');
  const [fileFormat, setFileFormat] = useState<GeneratedFileFormat>('pptx');
  const [docDesigned, setDocDesigned] = useState(true);
  const [docTheme, setDocTheme] = useState<DocThemeId>('auto');
  const [researchDepth, setResearchDepth] = useState<'standard' | 'exhaustive'>('standard');
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [useKnowledge, setUseKnowledge] = useState(false);
  const [outputLength, setOutputLength] = useState<'auto' | 'long' | 'max'>('auto');
  const [videoSeconds, setVideoSeconds] = useState<4 | 8 | 12>(8);
  const [pending, setPending] = useState<PreparedFile[]>([]);
  // The last send attempt, captured so a failed request can be retried exactly.
  const [lastAttempt, setLastAttempt] = useState<{
    text: string;
    attachments: PreparedFile[];
    mode: Mode;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [openArtifacts, setOpenArtifacts] = useState<Artifact[] | null>(null);
  const [docPreview, setDocPreview] = useState<PreviewTarget | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [usageMap, setUsageMap] = useState<Record<string, ModelUsage>>({});
  const [usageOpen, setUsageOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string>('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [caps, setCaps] = useState<Capabilities>({
    image: false,
    video: false,
    realtime: false,
    webSearch: false,
    knowledge: false,
  });

  const listEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<{ stop: () => void } | null>(null);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );
  const chatModels = useMemo(
    () => models.filter((m) => m.modality === 'chat' || m.modality === 'reasoning'),
    [models],
  );
  const activeModel = chatModels.find((m) => m.id === active?.modelId);

  // Load conversations + live model catalog on mount.
  useEffect(() => {
    const stored = loadConversations();
    setConversations(stored);
    setUsageMap(loadUsage());
    if (stored.length > 0) {
      setActiveId(stored[0]!.id);
    }
    let on = true;
    void getCapabilities().then((c) => {
      if (on) setCaps(c);
    });
    void listModels()
      .then((loaded) => {
        if (!on) return;
        setModels(loaded);
        const def = pickDefaultModel(loaded);
        setConversations((prev) => {
          if (prev.length > 0) return prev;
          const convo = createConversation(def);
          setActiveId(convo.id);
          return [convo];
        });
      })
      .catch((e: unknown) => {
        if (on) setError(e instanceof Error ? e.message : 'failed to load models');
      });
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    if (conversations.length > 0) {
      saveConversations(conversations);
    }
  }, [conversations]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [active?.messages]);

  // Auto-grow the composer textarea.
  useEffect(() => {
    const el = composerRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  // Close menus on outside click.
  useEffect(() => {
    if (!modelMenuOpen && !toolsMenuOpen) return;
    const onClick = () => {
      setModelMenuOpen(false);
      setToolsMenuOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [modelMenuOpen, toolsMenuOpen]);

  const patchConversation = useCallback(
    (id: string, patch: (c: Conversation) => Conversation) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...patch(c), updatedAt: new Date().toISOString() } : c)),
      );
    },
    [],
  );

  function handleNewChat() {
    const def = active?.modelId ?? pickDefaultModel(models);
    const convo = createConversation(def);
    setConversations((prev) => [convo, ...prev]);
    setActiveId(convo.id);
    setPending([]);
    setMode('text');
    setError(null);
    composerRef.current?.focus();
  }

  function handleDelete(id: string) {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(next);
      if (id === activeId) {
        setActiveId(next[0]?.id ?? '');
      }
      return next;
    });
  }

  function handleClearConversations() {
    if (conversations.length === 0) return;
    const ok = window.confirm('Clear all conversations? This cannot be undone.');
    if (!ok) return;
    setConversations([]);
    saveConversations([]);
    setActiveId('');
  }

  function handleRename(id: string, currentTitle: string) {
    const title = window.prompt('Rename chat', currentTitle);
    if (title !== null && title.trim().length > 0) {
      patchConversation(id, (c) => ({ ...c, title: title.trim() }));
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  /** Re-run the last send attempt verbatim (same text, attachments, and mode). */
  function handleRetry() {
    if (lastAttempt === null || streaming) return;
    void handleSend(undefined, lastAttempt.text, {
      mode: lastAttempt.mode,
      attachments: lastAttempt.attachments,
    });
  }

  /** Sign out of the shared application login and return to the sign-in screen. */
  function handleSignOut() {
    logout();
    window.location.reload();
  }

  async function handleFiles(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0) return;
    setError(null);
    try {
      const prepared = await Promise.all(Array.from(fileList).map((f) => prepareFile(f)));
      setPending((prev) => [...prev, ...prepared]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed to read file');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  /** Build the multimodal user content from text + attachments. */
  async function buildUserContent(
    text: string,
    files: PreparedFile[],
  ): Promise<string | ChatContentPart[]> {
    const images = files.filter((f) => f.isImage);
    const docs = files.filter((f) => !f.isImage);

    let textPart = text;
    if (docs.length > 0) {
      const extracted = await extractFiles(
        docs.map((d) => ({ name: d.name, mimeType: d.mimeType, base64: d.base64 })),
      );
      const docContext = extracted.map((e) => `--- Attached file: ${e.name} ---\n${e.text}`).join('\n\n');
      textPart = `${text}\n\n${docContext}`;
    }
    if (images.length === 0) return textPart;
    const parts: ChatContentPart[] = [{ type: 'text', text: textPart }];
    for (const img of images) {
      parts.push({ type: 'image', image: { mimeType: img.mimeType, base64: img.base64 } });
    }
    return parts;
  }

  async function handleSend(
    event?: React.FormEvent,
    overrideText?: string,
    retryCtx?: { mode?: Mode; attachments?: PreparedFile[] },
  ) {
    event?.preventDefault();
    const text = (overrideText ?? draft).trim();
    const attachments = retryCtx?.attachments ?? [...pending];
    const sendMode = retryCtx?.mode ?? mode;
    if ((text.length === 0 && attachments.length === 0) || streaming) return;

    let convo = active;
    if (convo === null) {
      convo = createConversation(pickDefaultModel(models));
      setConversations((prev) => [convo!, ...prev]);
      setActiveId(convo.id);
    }
    const convoId = convo.id;
    const modelId = convo.modelId;
    const priorMessages = convo.messages;

    setError(null);
    setDraft('');
    setPending([]);
    // Remember this attempt so it can be retried verbatim if it fails.
    setLastAttempt({ text, attachments, mode: sendMode });

    const userMessage: StoredMessage = {
      id: newId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.name) } : {}),
    };
    const assistantId = newId();
    const assistantMessage: StoredMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      model: sendMode === 'text' ? modelId : sendMode,
      kind: sendMode,
      createdAt: new Date().toISOString(),
    };

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convoId) return c;
        const isFirst = c.messages.length === 0;
        return {
          ...c,
          title: isFirst && text.length > 0 ? deriveTitle(text) : c.title,
          messages: [...c.messages, userMessage, assistantMessage],
          updatedAt: new Date().toISOString(),
        };
      }),
    );

    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const mediaMemory = buildMediaMemory(priorMessages);
      const recent = toChatHistory(priorMessages);

      // IMAGE MODE — enhance the prompt, then generate with a live progress UI.
      if (sendMode === 'image') {
        const applyGen = (gen: GenState): void =>
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantId ? { ...m, content: '', generating: gen } : m,
            ),
          }));
        const progress = startStagedProgress('image', IMAGE_PHASES, applyGen, { cap: 94 });
        try {
          progress.setPhase('Enhancing your prompt', 8);
          const resolved = await resolveGenerationPrompt(modelId, 'image', text, mediaMemory, recent);
          const prompt = await enhanceImagePrompt(modelId, resolved);
          // Show the enhanced prompt under the animation as it renders.
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === assistantId ? { ...m, genPrompt: prompt } : m)),
          }));
          progress.setPhase('Composing the scene', 18);
          const imgs = await generateImage(prompt, 1, '1024x1024', 'high');
          const urls = imgs
            .map((img) => (img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url ?? ''))
            .filter((u) => u.length > 0);
          progress.finish();
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantId
                ? { ...m, content: 'Here is your image:', images: urls, genPrompt: prompt, generating: undefined }
                : m,
            ),
          }));
        } catch (e) {
          progress.finish();
          throw e;
        }
        return;
      }

      // VIDEO MODE — resolve the prompt against context, then generate.
      if (sendMode === 'video') {
        const prompt = await resolveGenerationPrompt(modelId, 'video', text, mediaMemory, recent);
        patchConversation(convoId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId
              ? { ...m, content: '', genPrompt: prompt, generating: { kind: 'video', label: 'Queueing render', pct: 5 } }
              : m,
          ),
        }));
        const url = await generateVideo(
          prompt,
          (status, progressPct) => {
            const label = status === 'completed' ? 'Finalizing' : `Rendering ${videoSeconds}s video (${status})`;
            patchConversation(convoId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, generating: { kind: 'video', label, pct: Math.max(5, Math.min(95, progressPct)) } }
                  : m,
              ),
            }));
          },
          { signal: controller.signal, seconds: videoSeconds, size: '720x1280' },
        );
        patchConversation(convoId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Here is your ${videoSeconds}-second video:`, videos: [url], genPrompt: prompt, generating: undefined }
              : m,
          ),
        }));
        return;
      }

      // FILE MODE — ask the model for polished Markdown, then render a real file.
      if (sendMode === 'file') {
        const label = fileLabel(fileFormat);

        // DESIGNED DOCUMENT (Gamma-like) — for PPTX/PDF/DOCX with design on,
        // route through the structured design engine: themed layouts, charts,
        // KPIs, timelines, callouts and branding from a single prompt.
        const designable = fileFormat === 'pptx' || fileFormat === 'pdf' || fileFormat === 'docx';
        if (docDesigned && designable) {
          const designFormat = fileFormat as DesignedFormat;
          const lengthPreset = LENGTH_PRESETS[outputLength];
          const applyGen = (gen: GenState): void =>
            patchConversation(convoId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId ? { ...m, content: '', generating: gen } : m,
              ),
            }));
          const progress = startStagedProgress('file', DOC_PHASES, applyGen, { cap: 90, intervalMs: 900 });
          try {
            const result = await generateDesignedDocument(
              text,
              modelId,
              {
                format: designFormat,
                themeId: docTheme,
                ...(lengthPreset.maxTokens !== undefined ? { maxTokens: lengthPreset.maxTokens } : {}),
              },
              {
                signal: controller.signal,
                onStep: (_phase, message) => {
                  progress.setPhase(message);
                },
                onSpec: (info) => {
                  progress.setPhase(
                    `Rendering ${info.sectionCount} ${designFormat === 'pptx' ? 'slides' : 'pages'}`,
                    80,
                  );
                },
              },
            );
            progress.finish();
            const inTok = result.usage?.inputTokens ?? 0;
            const outTok = result.usage?.outputTokens ?? 0;
            const info = models.find((mi) => mi.id === modelId);
            const finalCost = resolveCost(undefined, info, result.usage);
            const themeLabel = DOC_THEMES.find((t) => t.id === result.themeId)?.label ?? result.themeId ?? 'themed';
            patchConversation(convoId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      kind: 'file',
                      model: modelId,
                      generating: undefined,
                      content: `Designed **${result.file.filename}** — ${result.sectionCount} ${designFormat === 'pptx' ? 'slides' : 'pages'}, ${themeLabel} theme.`,
                      files: [result.file],
                      ...(result.preview !== undefined ? { filePreview: result.preview } : {}),
                      inputTokens: inTok,
                      outputTokens: outTok,
                      cost: finalCost,
                    }
                  : m,
              ),
            }));
            // Open the designed result inline right away (Gamma-style preview).
            const designedTarget = toPreviewTarget(result.file, result.preview);
            if (designedTarget !== null) setDocPreview(designedTarget);
            if (inTok + outTok > 0) {
              setUsageMap(
                recordUsage({
                  modelId,
                  displayName: info?.displayName ?? modelId,
                  inputTokens: inTok,
                  outputTokens: outTok,
                  cost: finalCost,
                }),
              );
            }
          } catch (e: unknown) {
            progress.finish();
            const msg = e instanceof Error ? e.message : 'design failed';
            setError(msg);
            patchConversation(convoId, (c) => ({
              ...c,
              messages: c.messages.map((m) => (m.id === assistantId ? { ...m, content: `⚠️ ${msg}`, generating: undefined } : m)),
            }));
          }
          return;
        }

        patchConversation(convoId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId ? { ...m, content: `Drafting ${label} content…` } : m,
          ),
        }));

        // Format-specific prompt engineering for consulting-grade output.
        const isPptx = fileFormat === 'pptx';
        const isPdfDocx = fileFormat === 'pdf' || fileFormat === 'docx';
        const isData = fileFormat === 'xlsx' || fileFormat === 'csv';

        const fileSystemPrompt = isPptx
          ? [
              'You are an elite presentation architect combining the expertise of McKinsey, Bain, and BCG senior consultants, a TED presentation coach, and a Fortune 500 executive communications director.',
              '',
              'OBJECTIVE: Produce consulting-grade, board-ready Markdown that renders into a world-class PowerPoint.',
              '',
              'STRUCTURAL RULES (the renderer uses these exact conventions):',
              '- First H1 (#) = Cover slide title. Follow it with one short paragraph as the subtitle.',
              '- Subsequent H1s (#) = Section divider slides (navy background, used to separate major themes).',
              '- H2 (##) = Individual content slides. Each H2 becomes one slide.',
              '- Bullet points under H2 = Slide content. Use 4-6 concise bullets per slide (max 7).',
              '- Markdown tables = Rendered as real PowerPoint tables with styled headers.',
              '- Blockquotes (>) = Quote slides with decorative styling.',
              '- Code blocks = Speaker notes (not shown on slides).',
              '- H2 titled "Key Takeaways", "Summary", "Conclusion", or "Recommendations" = Summary slide with numbered points.',
              '- H2 titled "Thank You", "Questions", or "Q&A" = Closing slide with navy background.',
              '',
              'CONTENT QUALITY REQUIREMENTS:',
              '- Open with an Executive Summary slide after the title.',
              '- Include 3-5 major sections, each introduced by an H1 section divider.',
              '- Every slide must communicate ONE clear insight or decision point.',
              '- Use specific data, metrics, percentages, and frameworks — never generic filler.',
              '- Include at least 2 Markdown tables with real data for analytical slides.',
              '- Include at least 1 blockquote with a relevant expert/industry insight.',
              '- End with "Key Takeaways" (3-5 actionable points) and a "Thank You" slide.',
              '- Write bullets as crisp, action-oriented phrases (not full sentences).',
              '- Target 12-20 slides total for comprehensive coverage.',
              '',
              'PRESENTATION ARCHITECTURE:',
              '1. Cover → 2. Executive Summary → 3. Section Dividers + Content Slides → 4. Data/Table Slides → 5. Recommendations → 6. Key Takeaways → 7. Thank You',
              '',
              'Do NOT wrap output in code fences. Output raw Markdown only.',
            ].join('\n')
          : isPdfDocx
            ? [
                'You are an elite document author. Produce polished, executive-ready Markdown for a professional business document.',
                'Use proper heading hierarchy (H1 title, H2 sections, H3 subsections).',
                'Include tables, structured analysis, and clear recommendations.',
                'Write in a formal, authoritative tone suitable for C-suite distribution.',
                'Do NOT wrap output in code fences.',
              ].join('\n')
            : isData
              ? [
                  'You are a data analyst. Produce clean, well-structured Markdown tables.',
                  'Use proper column headers and consistent data formatting.',
                  'Include multiple tables if the data spans different categories.',
                  'Do NOT wrap output in code fences.',
                ].join('\n')
              : 'You are a senior document producer. Write polished, executive-ready Markdown. Do NOT wrap output in code fences.';

        const filePrompt = isPptx
          ? `Create a consulting-grade presentation in Markdown. Follow the structural rules exactly. User request: ${text}`
          : `Create high-quality source Markdown for a ${label} deliverable. ` +
            `For XLSX/CSV, include clean Markdown tables. For PDF/DOCX, structure it as a polished business document. ` +
            `Do not wrap the output in a code fence. User request: ${text}`;

        const { text: source, usage: fileUsage, cost: fileCost } = await completeText(
          modelId,
          [
            { role: 'system', content: fileSystemPrompt },
            ...recent.slice(-8),
            { role: 'user', content: filePrompt },
          ],
          isPptx ? 4500 : 3600,
        );
        patchConversation(convoId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId ? { ...m, content: `Rendering ${label}…\n\n${source}` } : m,
          ),
        }));
        const file = await generateFile(fileFormat, source, deriveTitle(text));
        const fileInTok = fileUsage?.inputTokens ?? 0;
        const fileOutTok = fileUsage?.outputTokens ?? 0;
        const fileInfo = models.find((mi) => mi.id === modelId);
        const fileFinalCost = resolveCost(fileCost, fileInfo, fileUsage);
        patchConversation(convoId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  kind: 'file',
                  model: modelId,
                  content: `Created **${file.filename}**.\n\n${source}`,
                  files: [file],
                  inputTokens: fileInTok,
                  outputTokens: fileOutTok,
                  cost: fileFinalCost,
                }
              : m,
          ),
        }));
        // PDFs preview natively in the browser — show the result immediately.
        const plainTarget = toPreviewTarget(file);
        if (plainTarget !== null) setDocPreview(plainTarget);
        if (fileInTok + fileOutTok > 0) {
          setUsageMap(
            recordUsage({
              modelId,
              displayName: fileInfo?.displayName ?? modelId,
              inputTokens: fileInTok,
              outputTokens: fileOutTok,
              cost: fileFinalCost,
            }),
          );
        }
        return;
      }

      // DEEP RESEARCH MODE — plan, search, read sources, synthesize cited report.
      // Drives a premium, structured research UI (timeline + sources + report).
      if (sendMode === 'research') {
        const exhaustive = researchDepth === 'exhaustive';
        let report = '';
        const research: ResearchState = {
          running: true,
          phase: 'planning',
          activity: [],
          queries: [],
          sources: [],
          outline: [],
          current: 0,
          total: 0,
          chars: 0,
          words: 0,
          exhaustive,
        };
        const pushResearch = () => {
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantId
                ? { ...m, kind: 'research', content: report, research: { ...research, sources: [...research.sources] } }
                : m,
            ),
          }));
        };
        research.activity.push({
          phase: 'planning',
          message: exhaustive ? 'Planning very deep research…' : 'Planning deep research…',
        });
        pushResearch();

        try {
          const researchLengthPreset = LENGTH_PRESETS[outputLength];

          // When the knowledge base is enabled, fold the ENTIRE indexed
          // knowledge base into the research as authoritative source material.
          let researchQuery = text;
          if (useKnowledge) {
            try {
              const budget = knowledgeBudgetChars(activeModel?.maxTokens);
              const kb = await getAllKnowledge(budget);
              if (kb.sources.length > 0) {
                researchQuery =
                  `${text}\n\nUse the following COMPLETE internal knowledge base (all ` +
                  `${kb.sourceCount} documents, each under its title) as authoritative, primary ` +
                  `source material and synthesize across them. Write naturally: do NOT insert ` +
                  `bracketed tags like "[Source 1]" or "[Source 9]" — if attribution helps, name ` +
                  `the document's title in prose:\n\n${formatFullKnowledge(kb.sources)}`;
                research.activity.push({
                  phase: 'planning',
                  message: `Folding in the full knowledge base (${kb.sourceCount} sources, ${kb.totalChars.toLocaleString()} chars)…`,
                });
                pushResearch();
              }
            } catch {
              /* KB enrichment is best-effort; proceed with the plain query. */
            }
          }

          const result = await runDeepResearch(researchQuery, modelId, {
            signal: controller.signal,
            depth: researchDepth,
            maxTokens: researchLengthPreset.maxTokens,
            onProgress: (p) => {
              research.phase = p.phase;
              if (p.message) {
                const last = research.activity[research.activity.length - 1];
                if (!last || last.message !== p.message) {
                  research.activity.push({ phase: p.phase, message: p.message });
                }
              }
              if (Array.isArray(p.queries)) research.queries = p.queries;
              if (Array.isArray(p.sections)) research.outline = p.sections;
              if (typeof p.current === 'number') research.current = p.current;
              if (typeof p.total === 'number') research.total = p.total;
              if (typeof p.chars === 'number') research.chars = p.chars;
              if (typeof p.words === 'number') research.words = p.words;
              pushResearch();
            },
            onSource: (source) => {
              research.sources.push({ index: source.index, title: source.title, url: source.url });
              pushResearch();
            },
            onToken: (delta) => {
              report += delta;
              research.chars = report.length;
              pushResearch();
            },
          });
          report = result.report;
          research.running = false;
          research.phase = 'done';
          research.chars = report.length;
          research.words = report.split(/\s+/).filter(Boolean).length;
          // Assemble an extraordinary research bundle (ZIP): the report in
          // Markdown/PDF/Word, a data workbook, charts generated from numeric
          // tables, the cited sources, and a manifest.
          let files: GeneratedFile[] = [];
          try {
            const title = deriveTitle(text);
            const renders = await Promise.allSettled([
              generateFile('pdf', report, title),
              generateFile('docx', report, title),
              generateFile('xlsx', report, title),
            ]);
            const names = ['report.pdf', 'report.docx', 'data/report-tables.xlsx'];
            const binaries: { name: string; base64: string }[] = [];
            renders.forEach((r, i) => {
              if (r.status === 'fulfilled') binaries.push({ name: names[i]!, base64: r.value.base64 });
            });
            const bundleSources = research.sources.map((s) => ({
              index: s.index,
              title: s.title,
              url: s.url,
            }));
            const entries = buildBundleEntries({
              title,
              reportMarkdown: report,
              sources: bundleSources,
              files: binaries,
            });
            const zipBase64 = await createZipBase64(entries);
            const zipName = `${(title || 'research-report').replace(/[^\w.-]+/g, '-').slice(0, 60)}-bundle.zip`;
            const zipFile: GeneratedFile = {
              filename: zipName,
              mimeType: 'application/zip',
              base64: zipBase64,
            };
            // Surface the PDF directly too (for quick in-browser preview).
            const pdf = renders[0].status === 'fulfilled' ? renders[0].value : undefined;
            files = pdf !== undefined ? [zipFile, pdf] : [zipFile];
          } catch {
            /* The bundle is a bonus; never fail the report over it. */
          }
          // Record usage from accumulated token counts.
          const resInTok = result.usage?.inputTokens ?? 0;
          const resOutTok = result.usage?.outputTokens ?? 0;
          const resInfo = models.find((mi) => mi.id === modelId);
          const resFinalCost = resolveCost(undefined, resInfo, result.usage);
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    kind: 'research',
                    model: modelId,
                    content: report,
                    research: { ...research, sources: [...research.sources] },
                    ...(files.length > 0 ? { files } : {}),
                    inputTokens: resInTok,
                    outputTokens: resOutTok,
                    cost: resFinalCost,
                  }
                : m,
            ),
          }));
          if (resInTok + resOutTok > 0) {
            setUsageMap(
              recordUsage({
                modelId,
                displayName: resInfo?.displayName ?? modelId,
                inputTokens: resInTok,
                outputTokens: resOutTok,
                cost: resFinalCost,
              }),
            );
          }
        } catch (e: unknown) {
          // Keep whatever report was produced; mark the run as stopped.
          research.running = false;
          research.error = e instanceof Error ? e.message : 'research stopped';
          if (!controller.signal.aborted) setError(`Research failed: ${research.error}`);
          patchConversation(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantId
                ? { ...m, kind: 'research', model: modelId, content: report, research: { ...research, sources: [...research.sources] } }
                : m,
            ),
          }));
        }
        return;
      }

      // TEXT / VISION MODE — full context + media memory + optional web search.
      const userContent = await buildUserContent(text, attachments);
      const lengthPreset = LENGTH_PRESETS[outputLength];
      const history: ChatMessage[] = [...recent, { role: 'user', content: userContent }];

      // System primer: identity + memory of generated media (context awareness).
      const primer = [
        'You are Auxify, an intelligent AI assistant. You have full memory of this conversation and everything discussed and created in it.',
        ARTIFACTS_PRIMER,
        VISUAL_PRIMER,
        mediaMemory,
        lengthPreset.directive,
      ]
        .filter((p) => p && p.length > 0)
        .join('\n\n');
      if (primer.length > 0) {
        history.unshift({ role: 'system', content: primer });
      }

      // Web-search sources cited by this answer (for citation chips + cards).
      let webSources: { index: number; title: string; url: string }[] = [];
      if (useWebSearch && text.length > 0) {
        try {
          const results = await webSearch(text, 6);
          if (results.length > 0) {
            webSources = results.map((r, i) => ({ index: i + 1, title: r.title, url: r.url }));
            const formatted = results
              .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet ?? ''}`)
              .join('\n\n');
            history.unshift({
              role: 'system',
              content:
                'Live web search results — ground your answer in them and cite sources inline ' +
                `using bracketed numbers like [1], [2]:\n\n${formatted}`,
            });
          }
        } catch (e: unknown) {
          setError(`Web search unavailable: ${e instanceof Error ? e.message : 'error'}`);
        }
      }

      // Knowledge-base grounding: when enabled, feed the ENTIRE knowledge base
      // to the model (every source, in full, up to the model's context budget)
      // so the answer is based on everything indexed — not just top matches.
      if (useKnowledge) {
        try {
          const budget = knowledgeBudgetChars(activeModel?.maxTokens);
          const kb = await getAllKnowledge(budget);
          if (kb.sources.length > 0) {
            const truncNote = kb.truncated
              ? '\n\n[Note: the knowledge base exceeded the context budget and was partially included.]'
              : '';
            history.unshift({
              role: 'system',
              content:
                `Complete company knowledge base — the following is the FULL content of all ` +
                `${kb.sourceCount} indexed document(s), each under its title. Treat this as ` +
                `authoritative and base your answer on ALL of it, synthesizing across the ` +
                `documents. Write naturally: do NOT insert bracketed reference tags such as ` +
                `"[Source 1]", "[Source 9]", or "[1]". If attribution helps, mention the ` +
                `document's title in the sentence instead.\n\n${formatFullKnowledge(kb.sources)}${truncNote}`,
            });
          } else {
            setError('The knowledge base is empty — add sources to ground answers in it.');
          }
        } catch (e: unknown) {
          setError(`Knowledge base unavailable: ${e instanceof Error ? e.message : 'error'}`);
        }
      }

      const { model, usage, cost } = await streamChat(
        modelId,
        history,
        (delta) => {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convoId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantId ? { ...m, content: m.content + delta } : m,
                    ),
                  }
                : c,
            ),
          );
        },
        { signal: controller.signal, ...(lengthPreset.maxTokens !== undefined ? { maxTokens: lengthPreset.maxTokens } : {}) },
      );
      // Attribute tokens + cost to this message and the per-user/model ledger.
      const resolvedModelId = model ?? modelId;
      const info = models.find((m) => m.id === resolvedModelId);
      const inTok = usage?.inputTokens ?? 0;
      const outTok = usage?.outputTokens ?? 0;
      const finalCost = resolveCost(cost, info, usage);
      patchConversation(convoId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                model: resolvedModelId,
                inputTokens: inTok,
                outputTokens: outTok,
                cost: finalCost,
                ...(webSources.length > 0 ? { sources: webSources } : {}),
              }
            : m,
        ),
      }));
      if (inTok + outTok > 0) {
        setUsageMap(
          recordUsage({
            modelId: resolvedModelId,
            displayName: info?.displayName ?? resolvedModelId,
            inputTokens: inTok,
            outputTokens: outTok,
            cost: finalCost,
          }),
        );
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'the request failed';
      if (!controller.signal.aborted) setError(message);
      patchConversation(convoId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === assistantId && m.content.length === 0 ? { ...m, content: `⚠️ ${message}` } : m,
        ),
      }));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend(event as unknown as React.FormEvent);
    }
  }

  /**
   * Export any assistant answer as a designed, themed PDF (deterministic —
   * no model call) and open the in-browser preview with a download action.
   */
  async function exportMessageAsPdf(message: StoredMessage) {
    if (exportingId !== null) return;
    setExportingId(message.id);
    setError(null);
    try {
      const title = active?.title !== undefined && active.title !== 'New chat' ? active.title : undefined;
      const result = await renderDesignedFromMarkdown(message.content, {
        format: 'pdf',
        ...(title !== undefined ? { title } : {}),
        ...(docTheme !== 'auto' ? { themeId: docTheme } : {}),
      });
      const target = toPreviewTarget(result.file, result.preview);
      if (target !== null) setDocPreview(target);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'PDF export failed');
    } finally {
      setExportingId(null);
    }
  }

  /** Open the inline preview for a generated file (PDF natively; PPTX/DOCX via their PDF preview). */
  function previewFile(file: GeneratedFile, preview?: GeneratedFile) {
    const target = toPreviewTarget(file, preview);
    if (target !== null) setDocPreview(target);
  }

  /** Voice mode through the realtime proxy. */
  async function toggleVoice() {
    if (voiceRef.current !== null) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setVoiceStatus('');
      return;
    }
    setVoiceStatus('connecting…');

    // Ensure a conversation exists so voice turns are captured into it.
    let convo = active;
    if (convo === null) {
      convo = createConversation(pickDefaultModel(models));
      setConversations((prev) => [convo!, ...prev]);
      setActiveId(convo.id);
    }
    const convoId = convo.id;
    // Snapshot the conversation context to seed the voice session with memory.
    const seedHistory = toChatHistory(convo.messages).slice(-12);
    const mediaMemory = buildMediaMemory(convo.messages);
    const voiceInstructions = [
      'You are Auxify, a helpful voice assistant. You have full memory of this conversation — everything that was discussed in text, and any images or videos created in it. Continue naturally from that context. Keep spoken replies concise and conversational.',
      mediaMemory,
    ]
      .filter((p) => p && p.length > 0)
      .join('\n\n');

    /** Append a captured voice turn into the active conversation. */
    const appendVoiceTurn = (role: 'user' | 'assistant', content: string) => {
      const trimmed = content.trim();
      if (trimmed.length === 0) return;
      patchConversation(convoId, (c) => {
        const isFirst = c.messages.length === 0;
        return {
          ...c,
          title: isFirst && role === 'user' ? deriveTitle(trimmed) : c.title,
          messages: [
            ...c.messages,
            {
              id: newId(),
              role,
              content: trimmed,
              createdAt: new Date().toISOString(),
              ...(role === 'assistant' ? { kind: 'text' as const, model: '🎙 voice' } : {}),
            },
          ],
        };
      });
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ws = new WebSocket(await getRealtimeWsUrl());
      ws.binaryType = 'arraybuffer';
      const playCtx = new AudioContext({ sampleRate: 24000 });
      let nextPlayTime = 0;
      let closed = false;
      let micCtx: AudioContext | null = null;
      let assistantTranscript = '';

      const stop = () => {
        closed = true;
        stream.getTracks().forEach((t) => t.stop());
        void playCtx.close();
        if (micCtx) void micCtx.close();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      };
      voiceRef.current = { stop };

      const encodePcm16 = (input: Float32Array, inRate: number): string => {
        const ratio = inRate / 24000;
        const outLen = Math.floor(input.length / ratio);
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]!));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
        return btoa(bin);
      };

      const playChunk = (b64: string) => {
        const raw = atob(b64);
        const pcm = new Int16Array(raw.length / 2);
        for (let i = 0; i < pcm.length; i++) {
          pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
        }
        const float = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) float[i] = pcm[i]! / 0x8000;
        const buffer = playCtx.createBuffer(1, float.length, 24000);
        buffer.getChannelData(0).set(float);
        const src = playCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(playCtx.destination);
        const now = playCtx.currentTime;
        if (nextPlayTime < now) nextPlayTime = now;
        src.start(nextPlayTime);
        nextPlayTime += buffer.duration;
      };

      ws.onopen = () => {
        // Configure the session: enable input transcription so we capture what
        // the user said, and seed the model's memory via instructions.
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['audio', 'text'],
              instructions: voiceInstructions,
              voice: 'alloy',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
            },
          }),
        );
        // Seed the realtime conversation with the prior text turns so the voice
        // model truly shares the chat's context (not just a summary).
        for (const turn of seedHistory) {
          const text = typeof turn.content === 'string' ? turn.content : '';
          if (text.trim().length === 0) continue;
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: turn.role === 'assistant' ? 'assistant' : 'user',
                content: [
                  turn.role === 'assistant'
                    ? { type: 'text', text }
                    : { type: 'input_text', text },
                ],
              },
            }),
          );
        }

        setVoiceStatus('🎙 Listening — tap mic again to stop');
        micCtx = new AudioContext();
        const source = micCtx.createMediaStreamSource(stream);
        const processor = micCtx.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(micCtx.destination);
        processor.onaudioprocess = (e) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          const audio = encodePcm16(e.inputBuffer.getChannelData(0), micCtx!.sampleRate);
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
        };
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data) as { type: string; delta?: string; transcript?: string };
          if (msg.type === 'response.audio.delta' && msg.delta) {
            playChunk(msg.delta);
          } else if (msg.type === 'response.audio_transcript.delta' && msg.delta) {
            assistantTranscript += msg.delta;
          } else if (msg.type === 'response.audio_transcript.done') {
            // The assistant finished speaking — record its words in the chat.
            appendVoiceTurn('assistant', assistantTranscript || msg.transcript || '');
            assistantTranscript = '';
            setVoiceStatus('🎙 Listening — tap mic again to stop');
          } else if (
            msg.type === 'conversation.item.input_audio_transcription.completed' &&
            typeof msg.transcript === 'string'
          ) {
            // The user's speech was transcribed — record it in the chat.
            appendVoiceTurn('user', msg.transcript);
          } else if (msg.type === 'error') {
            setVoiceStatus('voice error — see console');
            console.error('realtime error', msg);
          } else if (msg.type === 'input_audio_buffer.speech_started') {
            setVoiceStatus('🎙 You’re speaking…');
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => setVoiceStatus('voice connection error');
      ws.onclose = () => {
        if (voiceRef.current !== null) {
          voiceRef.current.stop?.();
          voiceRef.current = null;
          setVoiceStatus('');
        }
      };
    } catch (e: unknown) {
      setVoiceStatus('');
      setError(`Voice unavailable: ${e instanceof Error ? e.message : 'error'}`);
      voiceRef.current = null;
    }
  }

  const canSend = !streaming && (draft.trim().length > 0 || pending.length > 0);
  const composerPlaceholder =
    mode === 'image'
      ? 'Describe an image to create…'
      : mode === 'video'
        ? 'Describe a video to create…'
        : mode === 'file'
          ? `Describe the ${fileLabel(fileFormat)} you want…`
          : mode === 'research'
            ? 'Ask a research question…'
            : 'Message Auxify…';
  const modeBadge =
    mode === 'image'
      ? '🎨 Image'
      : mode === 'video'
        ? '🎬 Video'
        : mode === 'file'
          ? `📄 ${fileLabel(fileFormat)}`
          : mode === 'research'
            ? researchDepth === 'exhaustive'
              ? '🔬 Very deep research'
              : '🔎 Deep research'
            : null;

  const totals = usageTotals(usageMap);
  const usageBreakdown = usageRows(usageMap);

  return (
    <div className="ax" data-sidebar={sidebarOpen ? 'open' : 'closed'} data-artifacts={openArtifacts !== null ? 'open' : 'closed'}>
      {/* LEFT: conversation history */}
      <aside className="ax__rail" aria-label="Conversations">
        <div className="ax__rail-head">
          <div className="ax__brand">
            <BrandMark size={30} className="ax__brand-logo" />
            <span className="ax__brand-name">Auxify</span>
          </div>
          <button
            type="button"
            className="ax__iconbtn"
            aria-label="Collapse sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            ⟨
          </button>
        </div>

        <button type="button" className="ax__newchat" onClick={handleNewChat}>
          <span aria-hidden="true">＋</span> New chat
        </button>

        <nav className="ax__history" aria-label="Chat history">
          {conversations.length === 0 ? (
            <p className="ax__history-empty">No conversations yet.</p>
          ) : (
            conversations.map((c) => (
              <div key={c.id} className={`ax__hist ${c.id === activeId ? 'ax__hist--active' : ''}`}>
                <button type="button" className="ax__hist-open" onClick={() => setActiveId(c.id)} title={c.title}>
                  {c.title}
                </button>
                <span className="ax__hist-actions">
                  <button type="button" className="ax__iconbtn" aria-label="Rename" onClick={() => handleRename(c.id, c.title)}>
                    ✎
                  </button>
                  <button type="button" className="ax__iconbtn" aria-label="Delete" onClick={() => handleDelete(c.id)}>
                    🗑
                  </button>
                </span>
              </div>
            ))
          )}
        </nav>

        <div className="ax__rail-foot">
          {caps.knowledge ? (
            <button type="button" className="ax__foot-row" onClick={() => setKnowledgeOpen(true)}>
              <span className="ax__foot-ic" aria-hidden="true">🧠</span>
              Knowledge base
            </button>
          ) : null}
          <button type="button" className="ax__foot-row" onClick={() => setUsageOpen(true)}>
            <span className="ax__foot-ic" aria-hidden="true">📊</span>
            Usage &amp; cost
            {totals.cost > 0 ? <span className="ax__foot-tag">{formatCost(totals.cost)}</span> : null}
          </button>
          <button type="button" className="ax__foot-row" onClick={handleClearConversations}>
            <span className="ax__foot-ic" aria-hidden="true">🗑</span>
            Clear conversations
          </button>
          <button
            type="button"
            className="ax__foot-row"
            onClick={() => setPreference(resolved === 'dark' ? 'light' : 'dark')}
          >
            <span className="ax__foot-ic" aria-hidden="true">{resolved === 'dark' ? '☀' : '☾'}</span>
            {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <div className="ax__foot-row ax__foot-row--static">
            <span className="ax__foot-ic" aria-hidden="true">👤</span>
            My account
          </div>
          <button type="button" className="ax__foot-row" onClick={handleSignOut}>
            <span className="ax__foot-ic" aria-hidden="true">⎋</span>
            Sign out
          </button>
          <div className="ax__foot-row ax__foot-row--static">
            <span className="ax__foot-ic" aria-hidden="true">↗</span>
            Updates &amp; FAQ
          </div>
        </div>
      </aside>

      {/* CENTER */}
      <main className="ax__main">
        <header className="ax__topbar">
          {!sidebarOpen ? (
            <button type="button" className="ax__iconbtn" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
              ☰
            </button>
          ) : null}
          <span className="ax__topbar-title">{active?.title ?? 'New chat'}</span>
        </header>

        <div className="ax__thread" aria-live="polite">
          {active === null || active.messages.length === 0 ? (
            <div className="ax__welcome">
              <div className="ax__welcome-head">
                <BrandMark size={56} className="ax__welcome-logo" />
                <span className="ax__welcome-name">Auxify</span>
                <span className="ax__welcome-tag">Plus</span>
              </div>

              <div className="ax__cols">
                <section className="ax__col">
                  <header className="ax__col-head">
                    <span className="ax__col-icon" aria-hidden="true">☀</span>
                    <h2>Examples</h2>
                  </header>
                  {WELCOME_EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="ax__card ax__card--action"
                      onClick={() => void handleSend(undefined, ex.replace(/^"|"$/g, ''))}
                    >
                      {ex} →
                    </button>
                  ))}
                </section>

                <section className="ax__col">
                  <header className="ax__col-head">
                    <span className="ax__col-icon" aria-hidden="true">✦</span>
                    <h2>Capabilities</h2>
                  </header>
                  {WELCOME_CAPABILITIES.map((c) => (
                    <p key={c} className="ax__card">
                      {c}
                    </p>
                  ))}
                </section>

                <section className="ax__col">
                  <header className="ax__col-head">
                    <span className="ax__col-icon" aria-hidden="true">⚠</span>
                    <h2>Limitations</h2>
                  </header>
                  {WELCOME_LIMITATIONS.map((l) => (
                    <p key={l} className="ax__card">
                      {l}
                    </p>
                  ))}
                </section>
              </div>
            </div>
          ) : (
            <div className="ax__messages">
              {active.messages.map((m) => (
                <div key={m.id} className={`ax__msg ax__msg--${m.role}`}>
                  <div className="ax__avatar" aria-hidden="true">
                    {m.role === 'user' ? <span className="ax__avatar-user">You</span> : <BrandMark size={22} />}
                  </div>
                  <div className="ax__bubble">
                    {m.attachments && m.attachments.length > 0 ? (
                      <div className="ax__chips">
                        {m.attachments.map((name) => (
                          <span key={name} className="ax__chip">
                            📎 {name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {m.role === 'assistant' ? (
                      <>
                        <div className="ax__msg-head">
                          <span className="ax__msg-who">Auxify</span>
                          {m.model && m.kind !== 'image' && m.kind !== 'video' ? (
                            <span className="ax__msg-model">
                              {models.find((mm) => mm.id === m.model)?.displayName ?? m.model}
                            </span>
                          ) : null}
                        </div>
                        {m.kind === 'research' && m.research ? (
                          <ResearchView research={m.research} report={m.content} />
                        ) : m.generating ? (
                          <GenerationProgress
                            kind={m.generating.kind}
                            label={m.generating.label}
                            pct={m.generating.pct}
                            prompt={m.genPrompt ?? m.content}
                          />
                        ) : m.content ? (
                          <>
                            <Markdown sources={m.sources}>{m.content}</Markdown>
                            {m.sources && m.sources.length > 0 ? (
                              <SourceCards sources={m.sources} />
                            ) : null}
                          </>
                        ) : streaming ? (
                          <div className="ax__typing">
                            <span /> <span /> <span />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="ax__usertext">{m.content}</div>
                    )}
                    {m.role === 'assistant' && m.content && !streaming ? (
                      <div className="ax__msg-foot">
                        <div className="ax__msg-stats">
                          {(m.inputTokens ?? 0) + (m.outputTokens ?? 0) > 0 ? (
                            <span className="ax__stat" title="Tokens — input ▲ / output ▼">
                              ▲ {formatTokens(m.inputTokens ?? 0)} · ▼ {formatTokens(m.outputTokens ?? 0)}
                            </span>
                          ) : null}
                          {m.cost && m.cost > 0 ? (
                            <span className="ax__stat ax__stat--cost" title="Estimated cost for this reply">
                              {formatCost(m.cost)}
                            </span>
                          ) : null}
                        </div>
                        <div className="ax__msg-actions">
                          {extractArtifacts(m.content).length > 0 ? (
                            <button
                              type="button"
                              className="ax__msg-action ax__msg-action--primary"
                              onClick={() => setOpenArtifacts(extractArtifacts(m.content))}
                              title="View generated files in a side panel"
                            >
                              🗂 Open files ({extractArtifacts(m.content).length})
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ax__msg-action"
                            onClick={() => void navigator.clipboard?.writeText(m.content)}
                            title="Copy answer"
                          >
                            Copy
                          </button>
                          <button
                            type="button"
                            className="ax__msg-action"
                            disabled={exportingId !== null}
                            onClick={() => void exportMessageAsPdf(m)}
                            title="Export this answer as a designed PDF (preview + download)"
                          >
                            {exportingId === m.id ? '⏳ Designing…' : '↓ .pdf'}
                          </button>
                          <button
                            type="button"
                            className="ax__msg-action"
                            onClick={() => {
                              const stamp = new Date().toISOString().slice(0, 10);
                              downloadText(`auxify-answer-${stamp}.md`, m.content, 'text/markdown');
                            }}
                            title="Download answer as Markdown file"
                          >
                            ↓ .md
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {m.images && m.images.length > 0 ? (
                      <div className="ax__media">
                        {m.images.map((src, i) => (
                          <a key={i} href={src} download={`auxify-image-${i + 1}.png`} className="ax__media-item">
                            <img src={src} alt={`Generated ${i + 1}`} />
                          </a>
                        ))}
                      </div>
                    ) : null}
                    {m.videos && m.videos.length > 0 ? (
                      <div className="ax__media">
                        {m.videos.map((src, i) => (
                          <video key={i} src={src} controls className="ax__media-item" />
                        ))}
                      </div>
                    ) : null}
                    {m.files && m.files.length > 0 ? (
                      <div className="ax__files">
                        {m.files.map((file) => {
                          const previewable = toPreviewTarget(file, m.filePreview) !== null;
                          return (
                            <div key={file.filename} className="ax__file-card" role="group">
                              <span className="ax__file-icon" aria-hidden="true">📄</span>
                              <span className="ax__file-main">
                                <span className="ax__file-name">{file.filename}</span>
                                <span className="ax__file-meta">{file.mimeType}</span>
                              </span>
                              <span className="ax__file-actions">
                                {previewable ? (
                                  <button
                                    type="button"
                                    className="ax__file-btn"
                                    onClick={() => previewFile(file, m.filePreview)}
                                    title={`Preview ${file.filename}`}
                                  >
                                    👁 Preview
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="ax__file-btn ax__file-btn--primary"
                                  onClick={() => downloadGeneratedFile(file)}
                                  title={`Download ${file.filename}`}
                                >
                                  ↓ Download
                                </button>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
              <div ref={listEndRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="ax__composer-wrap">
          {error ? (
            <div className="ax__alert" role="status">
              <span className="ax__alert-msg">{error}</span>
              {lastAttempt !== null && !streaming ? (
                <button
                  type="button"
                  className="ax__alert-retry"
                  onClick={handleRetry}
                  title="Retry the last request"
                >
                  ↻ Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {voiceStatus ? <div className="ax__voice-status">{voiceStatus}</div> : null}
          {pending.length > 0 ? (
            <div className="ax__pending">
              {pending.map((f, i) => (
                <span key={`${f.name}-${i}`} className="ax__chip">
                  {f.isImage ? '🖼' : '📎'} {f.name}
                  <button
                    type="button"
                    className="ax__chip-x"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setPending((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <form className="ax__composer" onSubmit={handleSend}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => void handleFiles(e.target.files)}
              accept="image/*,.pdf,.csv,.txt,.md,.json,.xlsx,.xls,.docx,.doc,.xml,.js,.ts,.py"
            />

            {modeBadge ? (
              <div className="ax__mode-badge">
                {modeBadge}
                <button type="button" aria-label="Exit mode" onClick={() => setMode('text')}>
                  ×
                </button>
              </div>
            ) : null}

            <textarea
              ref={composerRef}
              className="ax__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={composerPlaceholder}
              rows={1}
            />

            <div className="ax__composer-bar">
              <div className="ax__composer-left">
                {/* Tools menu (＋) */}
                <div className="ax__menu-anchor">
                  <button
                    type="button"
                    className="ax__tool"
                    aria-label="Tools"
                    onClick={(e) => {
                      e.stopPropagation();
                      setToolsMenuOpen((v) => !v);
                      setModelMenuOpen(false);
                    }}
                  >
                    ＋
                  </button>
                  {toolsMenuOpen ? (
                    <div className="ax__menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="ax__menu-item"
                        onClick={() => {
                          fileInputRef.current?.click();
                          setToolsMenuOpen(false);
                        }}
                      >
                        📎 Attach files
                      </button>
                      {caps.image ? (
                        <button
                          type="button"
                          className={`ax__menu-item ${mode === 'image' ? 'ax__menu-item--on' : ''}`}
                          onClick={() => {
                            setMode(mode === 'image' ? 'text' : 'image');
                            setToolsMenuOpen(false);
                          }}
                        >
                          🎨 Create image
                        </button>
                      ) : null}
                      {caps.video ? (
                        <button
                          type="button"
                          className={`ax__menu-item ${mode === 'video' ? 'ax__menu-item--on' : ''}`}
                          onClick={() => {
                            setMode(mode === 'video' ? 'text' : 'video');
                            setToolsMenuOpen(false);
                          }}
                        >
                          🎬 Create video
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`ax__menu-item ${mode === 'file' ? 'ax__menu-item--on' : ''}`}
                        onClick={() => {
                          setMode(mode === 'file' ? 'text' : 'file');
                          setToolsMenuOpen(false);
                        }}
                      >
                        📄 Create file
                      </button>
                      <button
                        type="button"
                        className={`ax__menu-item ${mode === 'research' ? 'ax__menu-item--on' : ''}`}
                        onClick={() => {
                          setMode(mode === 'research' ? 'text' : 'research');
                          setToolsMenuOpen(false);
                        }}
                      >
                        🔎 Deep research
                      </button>
                      <div className="ax__menu-sep" />
                      <div className="ax__menu-label">Research depth</div>
                      <button
                        type="button"
                        className={`ax__menu-item ${researchDepth === 'standard' ? 'ax__menu-item--on' : ''}`}
                        onClick={() => {
                          setMode('research');
                          setResearchDepth('standard');
                          setToolsMenuOpen(false);
                        }}
                      >
                        🔎 Standard (fast, ~2–3k words)
                      </button>
                      <button
                        type="button"
                        className={`ax__menu-item ${researchDepth === 'exhaustive' ? 'ax__menu-item--on' : ''}`}
                        onClick={() => {
                          setMode('research');
                          setResearchDepth('exhaustive');
                          setToolsMenuOpen(false);
                        }}
                      >
                        🔬 Very deep (multi-batch, 100k+ chars)
                      </button>
                      {caps.webSearch ? (
                        <button
                          type="button"
                          className={`ax__menu-item ${useWebSearch ? 'ax__menu-item--on' : ''}`}
                          onClick={() => {
                            setUseWebSearch((v) => !v);
                            setToolsMenuOpen(false);
                          }}
                        >
                          🌐 Web search {useWebSearch ? '· on' : ''}
                        </button>
                      ) : null}
                      {caps.knowledge ? (
                        <button
                          type="button"
                          className={`ax__menu-item ${useKnowledge ? 'ax__menu-item--on' : ''}`}
                          onClick={() => {
                            setUseKnowledge((v) => !v);
                            setToolsMenuOpen(false);
                          }}
                        >
                          🧠 Use knowledge base {useKnowledge ? '· on' : ''}
                        </button>
                      ) : null}
                      <div className="ax__menu-sep" />
                      <div className="ax__menu-label">Response length</div>
                      {(['auto', 'long', 'max'] as const).map((len) => (
                        <button
                          key={len}
                          type="button"
                          className={`ax__menu-item ${outputLength === len ? 'ax__menu-item--on' : ''}`}
                          onClick={() => {
                            setOutputLength(len);
                            setToolsMenuOpen(false);
                          }}
                        >
                          {LENGTH_PRESETS[len].label}
                        </button>
                      ))}
                      {mode === 'file' ? (
                        <>
                          <div className="ax__menu-sep" />
                          <div className="ax__menu-label">File format</div>
                          {FILE_FORMATS.map((f) => (
                            <button
                              key={f.format}
                              type="button"
                              className={`ax__menu-item ${fileFormat === f.format ? 'ax__menu-item--on' : ''}`}
                              onClick={() => {
                                setFileFormat(f.format);
                                setToolsMenuOpen(false);
                              }}
                            >
                              {f.label}
                            </button>
                          ))}
                          {fileFormat === 'pptx' || fileFormat === 'pdf' || fileFormat === 'docx' ? (
                            <>
                              <div className="ax__menu-sep" />
                              <div className="ax__menu-label">Design</div>
                              <button
                                type="button"
                                className={`ax__menu-item ${docDesigned ? 'ax__menu-item--on' : ''}`}
                                onClick={() => setDocDesigned((v) => !v)}
                                title="Generate a fully designed, themed document with charts, KPIs and branding"
                              >
                                ✨ Designed layout {docDesigned ? '· On' : '· Off'}
                              </button>
                              {docDesigned ? (
                                <>
                                  <div className="ax__menu-label">Theme</div>
                                  {DOC_THEMES.map((t) => (
                                    <button
                                      key={t.id}
                                      type="button"
                                      className={`ax__menu-item ${docTheme === t.id ? 'ax__menu-item--on' : ''}`}
                                      onClick={() => {
                                        setDocTheme(t.id);
                                        setToolsMenuOpen(false);
                                      }}
                                    >
                                      {t.label}
                                    </button>
                                  ))}
                                </>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      ) : null}
                      {mode === 'video' ? (
                        <>
                          <div className="ax__menu-sep" />
                          <div className="ax__menu-label">Video length</div>
                          {([4, 8, 12] as const).map((s) => (
                            <button
                              key={s}
                              type="button"
                              className={`ax__menu-item ${videoSeconds === s ? 'ax__menu-item--on' : ''}`}
                              onClick={() => {
                                setVideoSeconds(s);
                                setToolsMenuOpen(false);
                              }}
                            >
                              {s} seconds
                            </button>
                          ))}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {/* Quick image button on the composer */}
                {caps.image ? (
                  <button
                    type="button"
                    className={`ax__tool ${mode === 'image' ? 'ax__tool--on' : ''}`}
                    aria-label="Create image"
                    title="Create image"
                    onClick={() => setMode(mode === 'image' ? 'text' : 'image')}
                  >
                    🎨
                  </button>
                ) : null}

                <button
                  type="button"
                  className={`ax__tool ${mode === 'file' ? 'ax__tool--on' : ''}`}
                  aria-label="Create file"
                  title="Create file"
                  onClick={() => setMode(mode === 'file' ? 'text' : 'file')}
                >
                  📄
                </button>

                <button
                  type="button"
                  className={`ax__tool ${mode === 'research' ? 'ax__tool--on' : ''}`}
                  aria-label="Deep research"
                  title="Deep research"
                  onClick={() => {
                    if (mode === 'research') {
                      setMode('text');
                    } else {
                      setMode('research');
                      setResearchDepth('standard');
                    }
                  }}
                >
                  🔎
                </button>

                <button
                  type="button"
                  className={`ax__tool ${mode === 'research' && researchDepth === 'exhaustive' ? 'ax__tool--on' : ''}`}
                  aria-label="Very deep research"
                  title="Very deep research"
                  onClick={() => {
                    setMode('research');
                    setResearchDepth('exhaustive');
                  }}
                >
                  🔬
                </button>

                {/* Web search toggle — click to turn web search on for the next replies */}
                {caps.webSearch ? (
                  <button
                    type="button"
                    className={`ax__search-toggle ${useWebSearch ? 'ax__search-toggle--on' : ''}`}
                    aria-pressed={useWebSearch}
                    title={useWebSearch ? 'Web search is on' : 'Turn on web search'}
                    onClick={() => setUseWebSearch((v) => !v)}
                  >
                    <span aria-hidden="true">🌐</span>
                    <span className="ax__search-toggle-label">Search</span>
                  </button>
                ) : null}

                {/* Knowledge-base toggle — ground the next replies in the org KB */}
                {caps.knowledge ? (
                  <button
                    type="button"
                    className={`ax__search-toggle ${useKnowledge ? 'ax__search-toggle--on' : ''}`}
                    aria-pressed={useKnowledge}
                    title={useKnowledge ? 'Answering from your knowledge base' : 'Use your knowledge base'}
                    onClick={() => setUseKnowledge((v) => !v)}
                  >
                    <span aria-hidden="true">🧠</span>
                    <span className="ax__search-toggle-label">KB</span>
                  </button>
                ) : null}

                {/* Model picker */}
                <div className="ax__menu-anchor">
                  <button
                    type="button"
                    className="ax__model-pick"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModelMenuOpen((v) => !v);
                      setToolsMenuOpen(false);
                    }}
                  >
                    {activeModel?.displayName ?? 'Select model'}
                    <span aria-hidden="true">▾</span>
                  </button>
                  {modelMenuOpen ? (
                    <div className="ax__menu ax__menu--models" onClick={(e) => e.stopPropagation()}>
                      {chatModels.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`ax__menu-item ${m.id === active?.modelId ? 'ax__menu-item--on' : ''}`}
                          disabled={!m.available}
                          onClick={() => {
                            if (active) patchConversation(active.id, (c) => ({ ...c, modelId: m.id }));
                            setModelMenuOpen(false);
                          }}
                        >
                          <span>{m.displayName}</span>
                          <span className="ax__menu-meta">
                            {m.provider}
                            {m.available ? '' : ' · locked'}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="ax__composer-right">
                {caps.realtime ? (
                  <button
                    type="button"
                    className={`ax__tool ${voiceRef.current ? 'ax__tool--rec' : ''}`}
                    aria-label="Voice conversation"
                    title="Voice conversation"
                    onClick={() => void toggleVoice()}
                    disabled={streaming}
                  >
                    {voiceRef.current ? '⏹' : '🎙'}
                  </button>
                ) : null}
                {streaming ? (
                  <button type="button" className="ax__send ax__send--stop" onClick={handleStop} aria-label="Stop">
                    ◼
                  </button>
                ) : (
                  <button type="submit" className="ax__send" disabled={!canSend} aria-label="Send">
                    ↑
                  </button>
                )}
              </div>
            </div>
          </form>
          <p className="ax__disclaimer">Auxify can make mistakes. Verify important information.</p>
        </div>
      </main>

      {openArtifacts !== null ? (
        <ArtifactsPanel artifacts={openArtifacts} onClose={() => setOpenArtifacts(null)} />
      ) : null}

      {docPreview !== null ? (
        <DocumentPreview target={docPreview} onClose={() => setDocPreview(null)} />
      ) : null}

      {knowledgeOpen ? (
        <KnowledgePanel
          onClose={() => setKnowledgeOpen(false)}
          visionModelId={
            (models.find((mm) => mm.id === active?.modelId)?.supportsVision
              ? active?.modelId
              : undefined) ?? models.find((mm) => mm.supportsVision)?.id
          }
        />
      ) : null}

      {usageOpen ? (
        <div className="ax__usage-overlay" role="dialog" aria-modal="true" aria-label="Usage and cost" onClick={() => setUsageOpen(false)}>
          <div className="ax__usage" onClick={(e) => e.stopPropagation()}>
            <header className="ax__usage-head">
              <div>
                <h2 className="ax__usage-title">Usage &amp; cost</h2>
                <p className="ax__usage-sub">Your token usage and estimated spend, by model.</p>
              </div>
              <button type="button" className="ax__iconbtn" aria-label="Close" onClick={() => setUsageOpen(false)}>
                ✕
              </button>
            </header>

            <div className="ax__usage-cards">
              <div className="ax__usage-card">
                <span className="ax__usage-k">Total cost</span>
                <span className="ax__usage-v ax__usage-v--accent">{formatCost(totals.cost)}</span>
              </div>
              <div className="ax__usage-card">
                <span className="ax__usage-k">Requests</span>
                <span className="ax__usage-v">{formatTokens(totals.requests)}</span>
              </div>
              <div className="ax__usage-card">
                <span className="ax__usage-k">Input tokens</span>
                <span className="ax__usage-v">{formatTokens(totals.inputTokens)}</span>
              </div>
              <div className="ax__usage-card">
                <span className="ax__usage-k">Output tokens</span>
                <span className="ax__usage-v">{formatTokens(totals.outputTokens)}</span>
              </div>
            </div>

            {usageBreakdown.length === 0 ? (
              <p className="ax__usage-empty">No usage yet. Send a message to start tracking tokens and cost.</p>
            ) : (
              <div className="ax__usage-table-wrap">
                <table className="ax__usage-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="ax__usage-num">Requests</th>
                      <th className="ax__usage-num">Input</th>
                      <th className="ax__usage-num">Output</th>
                      <th className="ax__usage-num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageBreakdown.map((row) => (
                      <tr key={row.modelId}>
                        <td>{row.displayName}</td>
                        <td className="ax__usage-num">{formatTokens(row.requests)}</td>
                        <td className="ax__usage-num">{formatTokens(row.inputTokens)}</td>
                        <td className="ax__usage-num">{formatTokens(row.outputTokens)}</td>
                        <td className="ax__usage-num ax__usage-num--cost">{formatCost(row.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <footer className="ax__usage-foot">
              <span className="ax__usage-note">Cost is estimated from each model&rsquo;s per-1K token price.</span>
              <button
                type="button"
                className="ax__msg-action"
                onClick={() => {
                  if (window.confirm('Reset all usage and cost tracking?')) {
                    resetUsage();
                    setUsageMap({});
                  }
                }}
              >
                Reset usage
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
