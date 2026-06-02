/**
 * Text chunking for the File_Processor (Req 11.4).
 *
 * Req 11.4 requires the File_Processor to split extracted text into chunks and
 * generate an embedding for each chunk. {@link chunkText} performs the split:
 * it produces fixed-size, optionally overlapping chunks over the normalized
 * text so that downstream embedding (one vector per chunk, Property 28) and
 * retrieval operate on bounded, consistent units.
 *
 * Chunking is intentionally pure and deterministic: the same text and options
 * always yield the same chunks, so the embedding/indexing invariants are easy
 * to test and reproduce.
 */

/** Tuning for {@link chunkText}. */
export interface ChunkOptions {
  /** Maximum characters per chunk (default {@link DEFAULT_CHUNK_SIZE}). */
  chunkSize?: number;
  /** Characters of overlap between consecutive chunks (default {@link DEFAULT_CHUNK_OVERLAP}). */
  overlap?: number;
}

/**
 * The default maximum chunk size, in characters.
 *
 * Sized so a chunk comfortably fits within an embedding model's context while
 * keeping retrieval granular. Character-based (rather than token-based) so the
 * split stays pure and model-independent at this layer.
 */
export const DEFAULT_CHUNK_SIZE = 1000;

/**
 * The default overlap between consecutive chunks, in characters.
 *
 * A small overlap preserves context that would otherwise be severed at a chunk
 * boundary, improving retrieval recall.
 */
export const DEFAULT_CHUNK_OVERLAP = 100;

/**
 * Collapse all runs of whitespace to single spaces and trim, so chunk
 * boundaries and lengths are computed over normalized text.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Split extracted text into fixed-size, overlapping chunks (Req 11.4).
 *
 * The text is whitespace-normalized first; an empty or whitespace-only input
 * yields no chunks (there is nothing to embed). Each chunk is at most
 * `chunkSize` characters; consecutive chunks overlap by `overlap` characters so
 * context that straddles a boundary is preserved.
 *
 * @param text The extracted text to split.
 * @param options Chunk size and overlap tuning.
 * @returns The ordered, non-empty chunks (possibly empty for blank input).
 * @throws {RangeError} When `chunkSize <= 0` or `overlap < 0` or `overlap >= chunkSize`.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP;

  if (chunkSize <= 0) {
    throw new RangeError(`chunkSize must be positive, got ${chunkSize}`);
  }
  if (overlap < 0) {
    throw new RangeError(`overlap must be non-negative, got ${overlap}`);
  }
  if (overlap >= chunkSize) {
    throw new RangeError(`overlap (${overlap}) must be smaller than chunkSize (${chunkSize})`);
  }

  const normalized = normalize(text);
  if (normalized.length === 0) {
    return [];
  }
  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const stride = chunkSize - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += stride) {
    const chunk = normalized.slice(start, start + chunkSize);
    chunks.push(chunk);
    if (start + chunkSize >= normalized.length) {
      break;
    }
  }
  return chunks;
}
