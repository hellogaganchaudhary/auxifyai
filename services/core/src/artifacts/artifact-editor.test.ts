/**
 * Unit tests for the Artifact_Editor service (Req 12.1-12.6).
 *
 * These exercise the service against in-memory fakes for its three ports
 * (artifact store, section editor, audit recorder), covering every acceptance
 * criterion with concrete examples and edge cases:
 *   - open() persists editable content as a new artifact routed to the side
 *     panel, supports all seven artifact types, rejects unknown types, and is
 *     audited (Req 12.1, 12.2);
 *   - applySectionEdit() changes only the targeted section, raises for a
 *     missing artifact / unresolved section, and is audited (Req 12.3);
 *   - every edit creates a new version and retains all prior versions, and
 *     listVersions/getVersion expose the history (Req 12.4);
 *   - export() produces a downloadable file plus a copy-to-clipboard string
 *     (Req 12.5);
 *   - share() merges members idempotently, makes the artifact accessible to
 *     them, and is audited (Req 12.6).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { ArtifactEditor } from './artifact-editor.js';
import { ArtifactNotFoundError, SectionNotFoundError, UnknownArtifactTypeError } from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryArtifactStore,
  sequentialArtifactIdGenerator,
} from './fakes.js';
import { ARTIFACT_TYPES, type ArtifactType, type SectionEditor } from './types.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };
const CONVERSATION = 'conv-1';

interface Harness {
  editor: ArtifactEditor;
  store: InMemoryArtifactStore;
  audit: CapturingAuditRecorder;
}

/**
 * Build a harness whose conversation `conv-1` belongs to `org-1`. A monotonic
 * clock makes each write's timestamp strictly increasing so newest-first
 * ordering and version timestamps are observable.
 */
function makeHarness(
  orgOf: (conversationId: string) => string | undefined = (c) =>
    c === CONVERSATION ? 'org-1' : undefined,
): Harness {
  let tick = 0;
  const store = new InMemoryArtifactStore(orgOf, () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
  });
  const audit = new CapturingAuditRecorder();
  const editor = new ArtifactEditor({
    artifacts: store,
    audit,
    idGenerator: sequentialArtifactIdGenerator(),
  });
  return { editor, store, audit };
}

describe('ArtifactEditor.open (Req 12.1, 12.2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('opens content as a new artifact routed to the editor side panel', async () => {
    const session = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: '# Title',
    });

    expect(session.target).toBe('artifact_editor');
    expect(session.artifact).toMatchObject({
      conversationId: CONVERSATION,
      type: 'markdown',
      content: '# Title',
      version: 1,
      sharedWith: [],
    });
    expect(session.artifact.id).toBe('art-1');
  });

  it('seeds version 1 history and records an audit event', async () => {
    const session = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'code',
      content: 'print(1)',
    });
    const versions = await h.editor.listVersions(ctx, session.artifact.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, content: 'print(1)' });
    expect(h.audit.withAction('artifact.open')).toHaveLength(1);
    expect(h.audit.last?.event.resourceId).toBe(session.artifact.id);
  });

  it.each(ARTIFACT_TYPES)('supports artifact type "%s" (Req 12.2)', async (type) => {
    const session = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type,
      content: `body for ${type}`,
    });
    expect(session.artifact.type).toBe(type);
    const reloaded = await h.editor.get(ctx, session.artifact.id);
    expect(reloaded?.type).toBe(type);
  });

  it('rejects an unsupported artifact type and does not persist or audit it', async () => {
    await expect(
      h.editor.open(ctx, {
        conversationId: CONVERSATION,
        type: 'pdf' as unknown as ArtifactType,
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(UnknownArtifactTypeError);
    expect(h.audit.count).toBe(0);
    expect(await h.editor.listByConversation(ctx, CONVERSATION)).toHaveLength(0);
  });

  it('refuses to open an artifact under a conversation outside the tenant', async () => {
    await expect(
      h.editor.open(ctx, {
        conversationId: 'foreign-conv',
        type: 'markdown',
        content: 'x',
      }),
    ).rejects.toThrow();
    expect(h.audit.withAction('artifact.open')).toHaveLength(0);
  });
});

describe('ArtifactEditor.applySectionEdit (Req 12.3)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('applies a heading-scoped change to that section only', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: '## Intro\nold intro\n\n## Details\nkeep me\n',
    });

    const updated = await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'heading', heading: 'Intro' },
      '## Intro\nnew intro\n',
    );

    expect(updated.content).toContain('new intro');
    expect(updated.content).not.toContain('old intro');
    // The untargeted sibling section is preserved verbatim.
    expect(updated.content).toContain('## Details\nkeep me');
    expect(updated.version).toBe(2);
  });

  it('applies a line-span change leaving surrounding lines intact', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'code',
      content: 'line1\nline2\nline3',
    });

    const updated = await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'lines', start: 2, end: 2 },
      'REPLACED',
    );

    expect(updated.content).toBe('line1\nREPLACED\nline3');
  });

  it('applies a literal replace-target change', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'html',
      content: '<h1>Hello</h1>',
    });

    const updated = await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'replace', target: 'Hello' },
      'World',
    );

    expect(updated.content).toBe('<h1>World</h1>');
  });

  it('records an audit event for each edit', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'a\nb\nc',
    });
    await h.editor.applySectionEdit(ctx, artifact.id, { kind: 'lines', start: 1, end: 1 }, 'A');
    expect(h.audit.withAction('artifact.edit')).toHaveLength(1);
    expect(h.audit.last?.event.metadata).toMatchObject({ section: 'lines', version: 2 });
  });

  it('raises ArtifactNotFoundError when the artifact does not exist', async () => {
    await expect(
      h.editor.applySectionEdit(ctx, 'missing', { kind: 'replace', target: 'x' }, 'y'),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('raises SectionNotFoundError (tagged with the real id) for an unresolved section', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: '# Present\nbody',
    });

    const error = await h.editor
      .applySectionEdit(ctx, artifact.id, { kind: 'heading', heading: 'Absent' }, 'x')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SectionNotFoundError);
    expect((error as SectionNotFoundError).artifactId).toBe(artifact.id);
    // A failed edit must not create a new version.
    expect(await h.editor.listVersions(ctx, artifact.id)).toHaveLength(1);
  });
});

describe('ArtifactEditor versioning retains all prior versions (Req 12.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('creates a new version on every edit and never drops a prior version', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'v1',
    });

    await h.editor.applySectionEdit(ctx, artifact.id, { kind: 'replace', target: 'v1' }, 'v2');
    const third = await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'replace', target: 'v2' },
      'v3',
    );

    expect(third.version).toBe(3);
    const versions = await h.editor.listVersions(ctx, artifact.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.content)).toEqual(['v1', 'v2', 'v3']);
  });

  it('exposes a single retained version via getVersion', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'first',
    });
    await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'replace', target: 'first' },
      'second',
    );

    expect(await h.editor.getVersion(ctx, artifact.id, 1)).toMatchObject({
      version: 1,
      content: 'first',
    });
    expect(await h.editor.getVersion(ctx, artifact.id, 2)).toMatchObject({
      version: 2,
      content: 'second',
    });
    expect(await h.editor.getVersion(ctx, artifact.id, 99)).toBeNull();
  });

  it('keeps prior version content unchanged after subsequent edits', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'code',
      content: 'original',
    });
    await h.editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'replace', target: 'original' },
      'edited',
    );

    const v1 = await h.editor.getVersion(ctx, artifact.id, 1);
    expect(v1?.content).toBe('original');
  });
});

describe('ArtifactEditor.export (Req 12.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('produces a downloadable file plus a copy-to-clipboard string', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: '# Doc\nbody',
    });

    const result = await h.editor.export(ctx, artifact.id);

    expect(result.clipboard).toBe('# Doc\nbody');
    expect(result.file).toMatchObject({
      filename: `artifact-${artifact.id}.md`,
      contentType: 'text/markdown',
      content: '# Doc\nbody',
      encoding: 'utf-8',
    });
  });

  it('uses the type-appropriate extension and content type for an SVG', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'svg',
      content: '<svg></svg>',
    });
    const result = await h.editor.export(ctx, artifact.id);
    expect(result.file.filename.endsWith('.svg')).toBe(true);
    expect(result.file.contentType).toBe('image/svg+xml');
  });

  it('raises ArtifactNotFoundError for a missing artifact', async () => {
    await expect(h.editor.export(ctx, 'missing')).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});

describe('ArtifactEditor.share (Req 12.6)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('makes the artifact accessible to the designated team members', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'x',
    });

    const updated = await h.editor.share(ctx, artifact.id, ['user-2', 'user-3']);
    expect(updated.sharedWith).toEqual(['user-2', 'user-3']);

    const reloaded = await h.editor.get(ctx, artifact.id);
    expect(reloaded?.sharedWith).toEqual(['user-2', 'user-3']);
    expect(h.audit.withAction('artifact.share')).toHaveLength(1);
  });

  it('merges members idempotently across repeated shares (de-duplicated, order-preserving)', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'x',
    });

    await h.editor.share(ctx, artifact.id, ['user-2']);
    const updated = await h.editor.share(ctx, artifact.id, ['user-2', 'user-4']);

    expect(updated.sharedWith).toEqual(['user-2', 'user-4']);
  });

  it('drops empty member ids', async () => {
    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'x',
    });
    const updated = await h.editor.share(ctx, artifact.id, ['', 'user-9', '']);
    expect(updated.sharedWith).toEqual(['user-9']);
  });

  it('raises ArtifactNotFoundError for a missing artifact', async () => {
    await expect(h.editor.share(ctx, 'missing', ['user-2'])).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });
});

describe('ArtifactEditor tenant isolation', () => {
  it("does not surface another organization's artifact", async () => {
    // conv-1 → org-1; conv-2 → org-2
    const orgOf = (c: string): string | undefined =>
      c === CONVERSATION ? 'org-1' : c === 'conv-2' ? 'org-2' : undefined;
    const h = makeHarness(orgOf);

    const { artifact } = await h.editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'secret',
    });

    const otherCtx: TenantContext = { organizationId: 'org-2', userId: 'user-9' };
    expect(await h.editor.get(otherCtx, artifact.id)).toBeNull();
    await expect(h.editor.export(otherCtx, artifact.id)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(
      h.editor.applySectionEdit(otherCtx, artifact.id, { kind: 'replace', target: 'secret' }, 'x'),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});

describe('ArtifactEditor with an injected AI-style SectionEditor', () => {
  it('delegates new-content computation to the injected port', async () => {
    let tick = 0;
    const store = new InMemoryArtifactStore(
      (c) => (c === CONVERSATION ? 'org-1' : undefined),
      () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    );
    const audit = new CapturingAuditRecorder();
    // A port that ignores the section and uppercases the whole content.
    const sectionEditor: SectionEditor = {
      edit: ({ content }) => content.toUpperCase(),
    };
    const editor = new ArtifactEditor({
      artifacts: store,
      audit,
      sectionEditor,
      idGenerator: sequentialArtifactIdGenerator(),
    });

    const { artifact } = await editor.open(ctx, {
      conversationId: CONVERSATION,
      type: 'markdown',
      content: 'hello',
    });
    const updated = await editor.applySectionEdit(
      ctx,
      artifact.id,
      { kind: 'replace', target: 'hello' },
      'ignored instruction',
    );

    expect(updated.content).toBe('HELLO');
    expect(updated.version).toBe(2);
  });
});
