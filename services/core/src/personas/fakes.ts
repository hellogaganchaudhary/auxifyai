/**
 * Test fakes and builders for the Persona_Manager.
 *
 * The manager composes two injected ports — an owner-scoped {@link PersonaStore}
 * and a narrow {@link ConversationPersonaStore}. These in-memory fakes let unit
 * and property tests drive the manager deterministically and inspect what was
 * persisted, without a database:
 *
 *   - {@link InMemoryPersonaStore} models the owner-scoped `PersonaRepository`:
 *     custom personas are confined to their owner (`ctx.userId`), so a user
 *     never sees another user's personas (Req 9.4).
 *   - {@link InMemoryConversationPersonaStore} models the narrow conversation
 *     seam `apply` uses: it finds and updates a conversation's `personaId`
 *     within the caller's Organization (Req 9.3).
 *   - {@link makePersonaRecord} / {@link sequentialPersonaIdGenerator} are small
 *     builders with sensible defaults.
 *
 * The fakes are exported (not test-only) so the concurrent variable-substitution
 * property test (task 9.2, Property 24) can reuse them.
 */

import type { TenantContext } from '@auxify/types';

import type { ConversationRecord, UpdateConversationInput } from '../repositories/index.js';
import type { PersonaIdGenerator } from './persona-manager.js';
import type { ConversationPersonaStore, PersonaRecord, PersonaStore } from './types.js';

/** Clone a persona record (with its variables) so stored state stays immutable. */
function clonePersonaRecord(record: PersonaRecord): PersonaRecord {
  return { ...record, variables: record.variables.map((v) => ({ ...v })) };
}

/**
 * An in-memory {@link PersonaStore} modelling the owner-scoped
 * `PersonaRepository`: rows are confined to their owner, so reads and lists for
 * one user never surface another user's custom personas (Req 9.4).
 */
export class InMemoryPersonaStore implements PersonaStore {
  private readonly rows = new Map<string, PersonaRecord>();

  /** Seed a fully-formed row (e.g. another user's persona, or fixed timestamps). */
  seed(record: PersonaRecord): void {
    this.rows.set(record.id, clonePersonaRecord(record));
  }

  async create(ctx: TenantContext, record: PersonaRecord): Promise<PersonaRecord> {
    // Mirror the repository: owner_id is forced onto the row from the context.
    const stored: PersonaRecord = clonePersonaRecord({ ...record, ownerId: ctx.userId });
    this.rows.set(stored.id, stored);
    return clonePersonaRecord(stored);
  }

  async findById(ctx: TenantContext, id: string): Promise<PersonaRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.ownerId !== ctx.userId) return null;
    return clonePersonaRecord(row);
  }

  async listOwned(ctx: TenantContext): Promise<PersonaRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ctx.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(clonePersonaRecord);
  }
}

/** Clone a conversation row so stored state stays immutable. */
function cloneConversation(record: ConversationRecord): ConversationRecord {
  return { ...record };
}

/**
 * An in-memory {@link ConversationPersonaStore} modelling the narrow conversation
 * seam `apply` uses: rows are confined to their Organization, and `update`
 * applies the `personaId` and bumps `updatedAt` (Req 9.3).
 */
export class InMemoryConversationPersonaStore implements ConversationPersonaStore {
  private readonly rows = new Map<string, ConversationRecord>();
  private clock: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Seed a fully-formed conversation row. */
  seed(record: ConversationRecord): void {
    this.rows.set(record.id, cloneConversation(record));
  }

  async findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneConversation(row);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    if (input.personaId !== undefined) row.personaId = input.personaId;
    if (input.activeModelId !== undefined) row.activeModelId = input.activeModelId;
    if (input.title !== undefined) row.title = input.title;
    row.updatedAt = this.clock().toISOString();
    return cloneConversation(row);
  }
}

/** Build a {@link PersonaRecord} with sensible defaults; override field-by-field. */
export function makePersonaRecord(overrides: Partial<PersonaRecord> = {}): PersonaRecord {
  return {
    id: 'persona-custom-1',
    ownerId: 'user-1',
    name: 'My Persona',
    category: 'custom',
    systemPrompt: 'You are my custom assistant.',
    isDefault: false,
    variables: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link ConversationRecord} with sensible defaults; override field-by-field. */
export function makeConversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: 'conv-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    ownerId: 'user-1',
    title: '',
    folderId: null,
    archived: false,
    shareToken: null,
    shareMode: null,
    personaId: null,
    activeModelId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A deterministic {@link PersonaIdGenerator} handing out `persona-custom-1`,
 * `persona-custom-2`, … ids for assertion-friendly tests.
 */
export function sequentialPersonaIdGenerator(): PersonaIdGenerator {
  let counter = 0;
  return {
    id: () => `persona-custom-${(counter += 1)}`,
  };
}
