/**
 * Content hashing for the Knowledge_Ingestion_Service change detection
 * (Req 23.4).
 *
 * Req 23.4 requires the service to detect a changed source document using a
 * content hash and re-index only changed documents. {@link Sha256ContentHasher}
 * is the default {@link ContentHasher}: a deterministic SHA-256 over the
 * UTF-8 bytes of the document content. Equal content always yields an equal
 * hash and different content yields a different hash (with cryptographic
 * collision resistance), so comparing the new hash to the stored hash is a
 * sound, stable change signal.
 *
 * Hashing is modelled as an injectable port so the algorithm is swappable and
 * tests can substitute a trivial deterministic hasher without pulling in the
 * crypto module.
 */

import { createHash } from 'node:crypto';

import type { ContentHasher } from './types.js';

/**
 * The default {@link ContentHasher}: a hex-encoded SHA-256 of the content's
 * UTF-8 bytes (Req 23.4).
 *
 * Deterministic and pure: the same content always hashes to the same value, so
 * change detection is reproducible across syncs and across processes.
 */
export class Sha256ContentHasher implements ContentHasher {
  /**
   * Compute the hex-encoded SHA-256 hash of `content`.
   *
   * @param content The parsed document text.
   * @returns The 64-character lower-case hex digest.
   */
  hash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }
}

/** A shared, stateless {@link Sha256ContentHasher} instance (the service default). */
export const sha256ContentHasher: ContentHasher = new Sha256ContentHasher();
