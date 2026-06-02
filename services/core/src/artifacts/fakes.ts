/**
 * Test fakes and builders for the Artifact_Editor.
 *
 * The editor composes an {@link ArtifactStore}, a {@link SectionEditor}, and an
 * {@link AuditRecorder}. These in-memory fakes let unit and property tests drive
 * the editor deterministically and inspect what was persisted and audited,
 * without a database:
 *
 *   - {@link InMemoryArtifactStore} models the tenant-scoped `ArtifactRepository`'s
 *     observable behaviour — artifacts confined to their conversation's
 *     Organization, the version-on-every-write invariant (create writes a
 *     version-1 row; updateContent appends the next version and advances the
 *     head), and a fully-retained, never-mutated version history (Req 12.4).
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert which mutations were audited (Req 37.1).
 *   - {@link makeArtifact} / {@link sequentialArtifactIdGenerator} are small
 *     builders with sensible defaults.
 *
 * The fakes are exported (not test-only) so the concurrent versioned-edits
 * property test (task 9.6, Property 25) can reuse exactly the same doubles.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  Artifact,
  ArtifactIdGenerator,
  ArtifactStore,
  ArtifactType,
  ArtifactVersion,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations were audited (Req 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `artifact.edit`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** Internal mutable row mirroring the `artifacts` head + its parent conversation. */
interface StoredArtifact extends Artifact {
  organizationId: string;
}

/** Clone an artifact so callers can never mutate stored state. */
function cloneArtifact(record: StoredArtifact): Artifact {
  return {
    id: record.id,
    conversationId: record.conversationId,
    type: record.type,
    content: record.content,
    version: record.version,
    sharedWith: [...record.sharedWith],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * An in-memory {@link ArtifactStore} modelling the tenant-scoped
 * `ArtifactRepository`.
 *
 * A conversation→Organization map provides the parent-tenant scope: an artifact
 * is only visible to the Organization that owns its conversation. The store
 * enforces the version-on-every-write invariant (Req 12.4) and retains the full
 * version history (never mutating or removing a prior version).
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, StoredArtifact>();
  private readonly versions = new Map<string, ArtifactVersion[]>();
  private clock: () => Date;

  /**
   * @param conversationOrg Resolves a conversation id to its owning Organization,
   *   modelling the parent-tenant scope. A conversation not in the map yields a
   *   cross-tenant rejection on create and no rows on read.
   * @param now Injected clock so timestamps are deterministic in tests.
   */
  constructor(
    private readonly conversationOrg: (conversationId: string) => string | undefined,
    now: () => Date = () => new Date('2026-01-01T00:00:00.000Z'),
  ) {
    this.clock = now;
  }

  /** Override the clock (e.g. to advance time between edits in a test). */
  setClock(now: () => Date): void {
    this.clock = now;
  }

  /** Whether an artifact belongs to a conversation in the caller's Organization. */
  private inTenant(ctx: TenantContext, record: StoredArtifact): boolean {
    return record.organizationId === ctx.organizationId;
  }

  async create(
    ctx: TenantContext,
    input: {
      id: string;
      versionId: string;
      conversationId: string;
      type: ArtifactType;
      content: string;
    },
  ): Promise<Artifact> {
    const org = this.conversationOrg(input.conversationId);
    if (org === undefined || org !== ctx.organizationId) {
      // Mirror the repository's parent EXISTS guard: a foreign/absent parent is
      // a cross-tenant reference and the write is refused.
      throw new Error(
        `Cannot create artifact: conversation "${input.conversationId}" is not in the current tenant`,
      );
    }
    const ts = this.clock().toISOString();
    const record: StoredArtifact = {
      id: input.id,
      organizationId: org,
      conversationId: input.conversationId,
      type: input.type,
      content: input.content,
      version: 1,
      sharedWith: [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(record.id, record);
    // Append the immutable version-1 history row (Req 12.4).
    this.versions.set(record.id, [
      {
        id: input.versionId,
        artifactId: record.id,
        version: 1,
        content: input.content,
        createdAt: ts,
      },
    ]);
    return cloneArtifact(record);
  }

  async findById(ctx: TenantContext, id: string): Promise<Artifact | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    return cloneArtifact(row);
  }

  async listByConversation(ctx: TenantContext, conversationId: string): Promise<Artifact[]> {
    if (this.conversationOrg(conversationId) !== ctx.organizationId) return [];
    return [...this.rows.values()]
      .filter((r) => r.conversationId === conversationId && this.inTenant(ctx, r))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(cloneArtifact);
  }

  async updateContent(
    ctx: TenantContext,
    id: string,
    input: { versionId: string; content: string },
  ): Promise<Artifact | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    const nextVersion = row.version + 1;
    const ts = this.clock().toISOString();
    // Retain the new content before advancing the head (Req 12.4).
    const history = this.versions.get(id) ?? [];
    history.push({
      id: input.versionId,
      artifactId: id,
      version: nextVersion,
      content: input.content,
      createdAt: ts,
    });
    this.versions.set(id, history);
    row.content = input.content;
    row.version = nextVersion;
    row.updatedAt = ts;
    return cloneArtifact(row);
  }

  async updateSharedWith(
    ctx: TenantContext,
    id: string,
    members: string[],
  ): Promise<Artifact | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    row.sharedWith = [...members];
    row.updatedAt = this.clock().toISOString();
    return cloneArtifact(row);
  }

  async listVersions(ctx: TenantContext, id: string): Promise<ArtifactVersion[]> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return [];
    return [...(this.versions.get(id) ?? [])]
      .sort((a, b) => a.version - b.version)
      .map((v) => ({ ...v }));
  }

  async getVersion(
    ctx: TenantContext,
    id: string,
    version: number,
  ): Promise<ArtifactVersion | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    const found = (this.versions.get(id) ?? []).find((v) => v.version === version);
    return found === undefined ? null : { ...found };
  }
}

/** Build an {@link Artifact} with sensible defaults; override field-by-field. */
export function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    conversationId: 'conv-1',
    type: 'markdown',
    content: '',
    version: 1,
    sharedWith: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A deterministic {@link ArtifactIdGenerator} handing out `art-1`, `art-2`, …
 * artifact ids and `ver-1`, `ver-2`, … version ids, for assertion-friendly tests.
 */
export function sequentialArtifactIdGenerator(): ArtifactIdGenerator {
  let artifactCounter = 0;
  let versionCounter = 0;
  return {
    artifactId: () => `art-${(artifactCounter += 1)}`,
    versionId: () => `ver-${(versionCounter += 1)}`,
  };
}
