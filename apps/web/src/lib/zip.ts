/**
 * A tiny, dependency-free ZIP writer (STORE method — no compression).
 *
 * Used to download a set of generated artifacts as a single `.zip`. It builds a
 * valid ZIP archive (local file headers + central directory + end record) with
 * CRC-32 per entry, which every OS unzip tool accepts. Compression is omitted
 * for simplicity; for text deliverables the size cost is negligible.
 */

/** One file to place in the archive. Provide exactly one content source. */
export interface ZipEntry {
  /** Path within the archive (forward slashes). */
  name: string;
  /** UTF-8 text contents. */
  content?: string;
  /** Binary contents as base64 (e.g. a generated PDF/DOCX/XLSX/PNG). */
  base64?: string;
  /** Raw binary contents. */
  bytes?: Uint8Array;
}

/** Precomputed CRC-32 table. */
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a little-endian uint16 into `view` at `offset`. */
function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
/** Write a little-endian uint32 into `view` at `offset`. */
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/**
 * Normalize an archive entry name so a crafted name cannot escape the
 * extraction root (zip-slip): backslashes become slashes, and `..`/`.`/empty
 * segments and absolute prefixes are dropped.
 */
function safeEntryName(name: string): string {
  const cleaned = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned.length > 0 ? cleaned : 'file';
}

/** Decode a base64 string into raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Resolve an entry's bytes from whichever content source it provided. */
function entryBytes(entry: ZipEntry, encoder: TextEncoder): Uint8Array {
  if (entry.bytes !== undefined) return entry.bytes;
  if (entry.base64 !== undefined) return base64ToBytes(entry.base64);
  return encoder.encode(entry.content ?? '');
}

/** Build a ZIP archive Blob from the given entries. */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(safeEntryName(entry.name));
    const data = entryBytes(entry, encoder);
    const crc = crc32(data);

    // Local file header (30 bytes + name) + data.
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); // local file header signature
    u16(lv, 4, 20); // version needed
    u16(lv, 6, 0); // flags
    u16(lv, 8, 0); // method: store
    u16(lv, 10, 0); // mod time
    u16(lv, 12, 0); // mod date
    u32(lv, 14, crc);
    u32(lv, 18, data.length); // compressed size
    u32(lv, 22, data.length); // uncompressed size
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0); // extra length
    local.set(nameBytes, 30);

    fileParts.push(local, data);

    // Central directory header (46 bytes + name).
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50); // central dir signature
    u16(cv, 4, 20); // version made by
    u16(cv, 6, 20); // version needed
    u16(cv, 8, 0); // flags
    u16(cv, 10, 0); // method
    u16(cv, 12, 0); // mod time
    u16(cv, 14, 0); // mod date
    u32(cv, 16, crc);
    u32(cv, 20, data.length);
    u32(cv, 24, data.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0); // extra length
    u16(cv, 32, 0); // comment length
    u16(cv, 34, 0); // disk number
    u16(cv, 36, 0); // internal attrs
    u32(cv, 38, 0); // external attrs
    u32(cv, 42, offset); // offset of local header
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50); // end of central dir signature
  u16(ev, 4, 0); // disk number
  u16(ev, 6, 0); // disk with central dir
  u16(ev, 8, entries.length); // entries on this disk
  u16(ev, 10, entries.length); // total entries
  u32(ev, 12, centralSize);
  u32(ev, 16, offset); // offset of central dir
  u16(ev, 20, 0); // comment length

  return new Blob([...fileParts, ...centralParts, end], { type: 'application/zip' });
}

/** Download a set of files as a single ZIP archive. */
export function downloadZip(filename: string, entries: ZipEntry[]): void {
  const blob = createZip(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Build a ZIP archive and return it base64-encoded (for storing as a file). */
export async function createZipBase64(entries: ZipEntry[]): Promise<string> {
  const blob = createZip(entries);
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
