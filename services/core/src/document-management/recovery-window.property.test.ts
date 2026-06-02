/**
 * Property-based test for the Document_Management_Service recovery window.
 *
 * Feature: auxify-ai-platform, Property 60: Document recovery succeeds exactly
 * within the recovery window.
 * Validates: Requirements 28.7.
 *
 * Requirement 28.7: "WHEN a user requests document recovery within the recovery
 * window after deletion, THE Document_Management_Service SHALL restore the
 * document from the Backup_Service." The recovery window is a
 * half-bounded-at-deletion, inclusive-at-the-deadline interval: a document
 * soft-deleted at `deletedAt` is recoverable for every `now` with
 * `deletedAt <= now <= deletedAt + windowMs`, and is permanently purged /
 * unrecoverable strictly past the deadline.
 *
 * This drives the REAL {@link DocumentManagementService} over the in-memory
 * fakes (imported directly from `./fakes.js`, never the barrel), with a
 * hand-advanced {@link MutableDocumentClock} as the only source of time, and
 * checks the service against an INDEPENDENT oracle for ANY recovery window, ANY
 * soft-delete instant, and ANY elapsed time before the recovery attempt:
 *
 *   1. RECOVER SUCCEEDS IFF WITHIN THE WINDOW — `recover` restores the document
 *      exactly when the elapsed time since deletion is `<= windowMs` (inclusive
 *      at the deadline). On success the document reappears as a live document
 *      (in `listFolder`), is removed from `listTrash`, re-emits an ingestion
 *      event (Req 28.5), its head bytes remain retrievable, and its backup is
 *      discarded.
 *   2. EXPIRY IS FAIL-CLOSED AND PURGES — strictly past the deadline `recover`
 *      throws {@link RecoveryWindowExpiredError} naming the deadline, and the
 *      document is permanently purged: absent from `getDocument`, `listTrash`,
 *      and `listFolder`, its backup discarded, and its bytes removed from the
 *      Object_Store, so it can no longer be recovered.
 *   3. `purgeExpired` PURGES EXACTLY THE ELAPSED DOCUMENTS — given many trashed
 *      documents deleted at varying instants, `purgeExpired` removes exactly the
 *      documents whose window has elapsed at "now" and leaves every still-in-
 *      window document recoverable in the trash.
 *
 * The oracle is the pure recovery core ({@link isWithinRecoveryWindow} /
 * {@link recoveryDeadlineMs}) computed independently of the service's branch, and
 * the inclusive-at-the-deadline boundary is also pinned by explicit example
 * cases (elapsed exactly at the deadline succeeds; one millisecond past fails).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Principal } from '@auxify/types';

import { DocumentManagementService } from './document-management-service.js';
import { RecoveryWindowExpiredError } from './errors.js';
import {
  AllowAllDocAuthorizer,
  CapturingAuditRecorder,
  CapturingDocumentIngestionEmitter,
  InMemoryDocumentBackupStore,
  InMemoryDocumentStore,
  InMemoryObjectStore,
  MutableDocumentClock,
  RecordingComplianceManager,
  makeBytes,
  makePrincipal,
  monotonicClock,
  sequentialDocumentIdGenerator,
} from './fakes.js';
import { isWithinRecoveryWindow, recoveryDeadlineMs } from './recovery.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

const PROJECT = 'proj-1';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  service: DocumentManagementService;
  store: InMemoryDocumentStore;
  objects: InMemoryObjectStore;
  audit: CapturingAuditRecorder;
  ingestion: CapturingDocumentIngestionEmitter;
  backup: InMemoryDocumentBackupStore;
  clock: MutableDocumentClock;
  principal: Principal;
}

/**
 * Wire the real service over the in-memory fakes with the recovery clock fixed
 * at `startMs` and the recovery window set to `windowMs`. An allow-all authorizer
 * keeps the test focused on the recovery window rather than the permission path.
 */
function makeHarness(startMs: number, windowMs: number): Harness {
  const store = new InMemoryDocumentStore(monotonicClock());
  const objects = new InMemoryObjectStore();
  const audit = new CapturingAuditRecorder();
  const ingestion = new CapturingDocumentIngestionEmitter();
  const backup = new InMemoryDocumentBackupStore();
  const compliance = new RecordingComplianceManager();
  const clock = new MutableDocumentClock(startMs);
  const service = new DocumentManagementService({
    documents: store,
    objectStore: objects,
    audit,
    ingestion,
    backup,
    compliance,
    authorizer: new AllowAllDocAuthorizer(),
    clock,
    recoveryWindowMs: windowMs,
    idGenerator: sequentialDocumentIdGenerator(),
  });
  const principal = makePrincipal({
    userId: 'user-1',
    organizationId: 'org-1',
    projectIds: [PROJECT],
  });
  return { service, store, objects, audit, ingestion, backup, clock, principal };
}

/** Whether the project root currently lists a live document with the given id. */
async function liveListingHas(h: Harness, docId: string): Promise<boolean> {
  const live = await h.service.listFolder(h.principal, PROJECT, null);
  return live.some((d) => d.id === docId);
}

/** Whether the trash currently lists a soft-deleted document with the given id. */
async function trashHas(h: Harness, docId: string): Promise<boolean> {
  const trash = await h.service.listTrash(h.principal, PROJECT);
  return trash.some((d) => d.id === docId);
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

/**
 * A single-document recovery scenario: a window, the instant the document was
 * soft-deleted, and the elapsed time (always `>= 0`) before the recovery attempt.
 *
 * The elapsed time is biased toward the deadline so the inclusive boundary is
 * exercised frequently: exactly at deletion, exactly at the deadline, one ms past
 * it, and uniformly across and beyond the window.
 */
const recoverScenarioArb = fc
  .integer({ min: 1, max: 90 * DAY_MS })
  .chain((windowMs) =>
    fc.record({
      windowMs: fc.constant(windowMs),
      startMs: fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) }),
      elapsedMs: fc.oneof(
        fc.constant(0), // recover immediately — within
        fc.constant(windowMs), // exactly at the deadline — within (inclusive)
        fc.constant(windowMs + 1), // one ms past the deadline — expired
        fc.integer({ min: 0, max: windowMs }), // anywhere within
        fc.integer({ min: windowMs, max: windowMs * 2 + 10 }), // around / past the deadline
      ),
    }),
  );

/**
 * A multi-document purge scenario: a shared window, a common "now", and a set of
 * documents each soft-deleted at `now - deletedOffsetMs`. A document's window has
 * elapsed at `now` iff its `deletedOffsetMs > windowMs`, so the offsets are biased
 * toward the deadline to cover both sides of the boundary.
 */
const purgeScenarioArb = fc
  .integer({ min: 1, max: 90 * DAY_MS })
  .chain((windowMs) =>
    fc.record({
      windowMs: fc.constant(windowMs),
      nowMs: fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2030, 0, 1) }),
      deletedOffsets: fc.array(
        fc.oneof(
          fc.constant(0), // deleted "now" — within
          fc.constant(windowMs), // exactly at the deadline — within
          fc.constant(windowMs + 1), // just past the deadline — expired
          fc.integer({ min: 0, max: windowMs }), // within
          fc.integer({ min: windowMs, max: windowMs * 2 + 10 }), // around / past
        ),
        { minLength: 1, maxLength: 8 },
      ),
    }),
  );

// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 60: Document recovery succeeds exactly within the recovery window', () => {
  it('recover restores a soft-deleted document iff the attempt is within the window (inclusive), else throws and purges (Validates: Requirements 28.7)', async () => {
    await fc.assert(
      fc.asyncProperty(recoverScenarioArb, async ({ windowMs, startMs, elapsedMs }) => {
        const h = makeHarness(startMs, windowMs);

        // Upload a live document, then soft-delete it at `startMs`.
        const body = makeBytes('recoverable document body');
        const doc = await h.service.upload(h.principal, {
          projectId: PROJECT,
          name: 'spec.pdf',
          contentType: 'application/pdf',
          bytes: body,
        });
        const emissionsAfterUpload = h.ingestion.forDocument(doc.id).length;

        await h.service.softDelete(h.principal, doc.id);
        // Soft-delete moves it out of the live listing and into the trash.
        expect(await liveListingHas(h, doc.id)).toBe(false);
        expect(await trashHas(h, doc.id)).toBe(true);
        expect(h.backup.has({ organizationId: 'org-1', userId: 'user-1' }, doc.id)).toBe(true);

        // Advance the recovery clock by the elapsed time before the recovery attempt.
        h.clock.advance(elapsedMs);

        // Independent oracle: the pure recovery core, plus the direct elapsed test.
        const deletedAtMs = startMs;
        const nowMs = startMs + elapsedMs;
        const withinWindow = isWithinRecoveryWindow(deletedAtMs, nowMs, windowMs);
        expect(recoveryDeadlineMs(deletedAtMs, windowMs)).toBe(startMs + windowMs);
        expect(withinWindow).toBe(elapsedMs <= windowMs);

        if (withinWindow) {
          // (1) Within the window: recovery restores the document.
          const restored = await h.service.recover(h.principal, doc.id);
          expect(restored.id).toBe(doc.id);
          expect(restored.deletedAt).toBeUndefined();

          // It reappears as a live document and leaves the trash.
          expect(await liveListingHas(h, doc.id)).toBe(true);
          expect(await trashHas(h, doc.id)).toBe(false);

          // A restore re-emits exactly one ingestion event (Req 28.5) ...
          expect(h.ingestion.forDocument(doc.id).length).toBe(emissionsAfterUpload + 1);
          // ... the backup is discarded ...
          expect(h.backup.has({ organizationId: 'org-1', userId: 'user-1' }, doc.id)).toBe(false);
          // ... and the head bytes are still retrievable.
          expect(await h.service.getBytes(h.principal, doc.id)).toEqual(body);

          // The restored document is the live head returned by getDocument.
          const head = await h.service.getDocument(h.principal, doc.id);
          expect(head?.deletedAt).toBeUndefined();
        } else {
          // (2) Past the window: recovery fails closed and purges permanently.
          let thrown: unknown;
          try {
            await h.service.recover(h.principal, doc.id);
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RecoveryWindowExpiredError);
          expect((thrown as RecoveryWindowExpiredError).documentId).toBe(doc.id);
          expect((thrown as RecoveryWindowExpiredError).recoverableUntil).toBe(
            new Date(startMs + windowMs).toISOString(),
          );

          // The document is permanently gone — unrecoverable from every surface.
          expect(await h.service.getDocument(h.principal, doc.id)).toBeNull();
          expect(await trashHas(h, doc.id)).toBe(false);
          expect(await liveListingHas(h, doc.id)).toBe(false);
          expect(h.backup.has({ organizationId: 'org-1', userId: 'user-1' }, doc.id)).toBe(false);
          // Its bytes were removed from the Object_Store.
          expect(await h.objects.exists(doc.objectKey)).toBe(false);

          // A second recovery attempt cannot resurrect it — it is simply not found.
          await expect(h.service.recover(h.principal, doc.id)).rejects.toThrow();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('recovery is recoverable exactly at the deadline instant and unrecoverable one millisecond later (boundary)', async () => {
    const START = Date.UTC(2026, 0, 1, 0, 0, 0);
    const WINDOW = 30 * DAY_MS;

    // Exactly at the deadline: still recoverable (inclusive boundary).
    {
      const h = makeHarness(START, WINDOW);
      const doc = await h.service.upload(h.principal, {
        projectId: PROJECT,
        name: 'a.txt',
        contentType: 'text/plain',
        bytes: makeBytes('body'),
      });
      await h.service.softDelete(h.principal, doc.id);
      h.clock.set(START + WINDOW); // now === deadline
      const restored = await h.service.recover(h.principal, doc.id);
      expect(restored.deletedAt).toBeUndefined();
      expect(await liveListingHas(h, doc.id)).toBe(true);
    }

    // One millisecond past the deadline: unrecoverable and purged.
    {
      const h = makeHarness(START, WINDOW);
      const doc = await h.service.upload(h.principal, {
        projectId: PROJECT,
        name: 'a.txt',
        contentType: 'text/plain',
        bytes: makeBytes('body'),
      });
      await h.service.softDelete(h.principal, doc.id);
      h.clock.set(START + WINDOW + 1); // now === deadline + 1ms
      await expect(h.service.recover(h.principal, doc.id)).rejects.toBeInstanceOf(
        RecoveryWindowExpiredError,
      );
      expect(await h.service.getDocument(h.principal, doc.id)).toBeNull();
    }
  });

  it('purgeExpired purges exactly the documents whose window has elapsed and leaves the rest recoverable (Validates: Requirements 28.7)', async () => {
    await fc.assert(
      fc.asyncProperty(purgeScenarioArb, async ({ windowMs, nowMs, deletedOffsets }) => {
        // Start the clock well before "now" so uploads happen first, then each
        // document is soft-deleted at its own instant `nowMs - offset`.
        const h = makeHarness(nowMs, windowMs);

        const expectedExpired = new Set<string>();
        const expectedWithin = new Set<string>();

        for (let i = 0; i < deletedOffsets.length; i += 1) {
          const offset = deletedOffsets[i]!;
          const doc = await h.service.upload(h.principal, {
            projectId: PROJECT,
            name: `doc-${i}.txt`,
            contentType: 'text/plain',
            bytes: makeBytes(`body-${i}`),
          });
          // Soft-delete this document at `nowMs - offset`.
          h.clock.set(nowMs - offset);
          await h.service.softDelete(h.principal, doc.id);

          // Independent oracle for purge eligibility at `nowMs`.
          const within = isWithinRecoveryWindow(nowMs - offset, nowMs, windowMs);
          expect(within).toBe(offset <= windowMs);
          if (within) {
            expectedWithin.add(doc.id);
          } else {
            expectedExpired.add(doc.id);
          }
        }

        // Run the periodic purge at `nowMs`.
        h.clock.set(nowMs);
        const purged = await h.service.purgeExpired(h.principal, PROJECT);

        // (3) Exactly the elapsed documents were purged.
        expect(new Set(purged)).toEqual(expectedExpired);
        expect(purged).toHaveLength(expectedExpired.size);

        // Every purged document is permanently gone.
        for (const id of expectedExpired) {
          expect(await h.service.getDocument(h.principal, id)).toBeNull();
          expect(await trashHas(h, id)).toBe(false);
        }

        // Every still-in-window document remains in the trash, recoverable.
        const remainingTrash = await h.service.listTrash(h.principal, PROJECT);
        expect(new Set(remainingTrash.map((d) => d.id))).toEqual(expectedWithin);
        for (const id of expectedWithin) {
          const head = await h.service.getDocument(h.principal, id);
          expect(head?.deletedAt).toBeDefined();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
