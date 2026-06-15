'use client';

/**
 * The Knowledge panel — manage the organization's RAG knowledge base.
 *
 * Users paste/add text sources (which the server embeds into pgvector), see the
 * indexed sources, and run a quick semantic search to confirm retrieval. Once a
 * source is added, the chat automatically grounds answers in it (server-side
 * RAG), so this panel is the on-ramp to the platform's "complete memory".
 */

import { useEffect, useRef, useState } from 'react';

import {
  addKnowledgeSource,
  describeImageForIndex,
  extractFiles,
  listKnowledgeSources,
  prepareFile,
  searchKnowledge,
  type KnowledgeHit,
  type KnowledgeSource,
} from '@/lib/chat-client';

/** Props for the knowledge panel. */
interface KnowledgePanelProps {
  /** Close handler (hides the modal). */
  onClose: () => void;
  /** A vision-capable model id used to OCR/describe uploaded images. */
  visionModelId?: string;
}

/** The org knowledge-base manager modal. */
export function KnowledgePanel({ onClose, visionModelId }: KnowledgePanelProps) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let on = true;
    void listKnowledgeSources()
      .then((s) => {
        if (on) setSources(s);
      })
      .catch((e: unknown) => {
        if (on) setError(e instanceof Error ? e.message : 'failed to load sources');
      });
    return () => {
      on = false;
    };
  }, []);

  async function handleAdd() {
    if (name.trim().length === 0 || text.trim().length === 0) {
      setError('Give the source a name and some text.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addKnowledgeSource(name.trim(), text.trim());
      const refreshed = await listKnowledgeSources();
      setSources(refreshed);
      setName('');
      setText('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed to add source');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ingest uploaded documents into the knowledge base. Each file is extracted
   * to text server-side (PDF / Word / Excel / CSV / text / code), then indexed
   * as its own source so chat answers ground in it. Unsupported or failed
   * files are skipped with a note rather than aborting the whole batch.
   */
  async function handleFiles(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0) return;
    setBusy(true);
    setError(null);
    setUploadStatus(`Reading ${fileList.length} file(s)…`);
    try {
      const prepared = await Promise.all(Array.from(fileList).map((f) => prepareFile(f)));
      const docs = prepared.filter((p) => !p.isImage);
      const images = prepared.filter((p) => p.isImage);

      let indexed = 0;
      let processed = 0;
      const total = prepared.length;
      const failures: string[] = [];

      // --- Images: OCR + describe via a vision model, then index. ---
      if (images.length > 0 && visionModelId !== undefined && visionModelId.length > 0) {
        for (const img of images) {
          processed += 1;
          setUploadStatus(`Reading image ${img.name}… (${processed}/${total})`);
          const text = await describeImageForIndex(
            visionModelId,
            { mimeType: img.mimeType, base64: img.base64 },
            img.name,
          );
          if (text.trim().length === 0) {
            failures.push(img.name);
            continue;
          }
          try {
            await addKnowledgeSource(img.name, text);
            indexed += 1;
            setSources(await listKnowledgeSources());
          } catch {
            failures.push(img.name);
          }
        }
      } else if (images.length > 0) {
        for (const img of images) failures.push(img.name);
      }

      // --- Documents: deep extraction + indexing, ONE file per request. ---
      // One file per request keeps each call small and well within limits, and
      // both extractFiles + addKnowledgeSource retry internally — so indexing
      // never fails on a slow/large file, it just takes the time it needs.
      if (docs.length > 0) {
        for (const doc of docs) {
          processed += 1;
          setUploadStatus(
            `Indexing ${doc.name} (${processed}/${total})… large files can take a while — please keep this open.`,
          );
          try {
            const extracted = await extractFiles(
              [{ name: doc.name, mimeType: doc.mimeType, base64: doc.base64 }],
              true,
            );
            const file = extracted[0];
            if (file === undefined || file.failed || file.text.trim().length === 0) {
              failures.push(doc.name);
            } else {
              await addKnowledgeSource(file.name, file.text, (attempt) => {
                setUploadStatus(
                  `Still indexing ${doc.name} (${processed}/${total})… retry ${attempt}, this is normal for large documents.`,
                );
              });
              indexed += 1;
            }
          } catch {
            // Exhausted all retries — record and keep going with the rest.
            failures.push(doc.name);
          }
          setSources(await listKnowledgeSources());
        }
      }

      setSources(await listKnowledgeSources());
      const parts = [`Indexed ${indexed} of ${total} file(s).`];
      if (images.length > 0 && (visionModelId === undefined || visionModelId.length === 0)) {
        parts.push('Images need a vision-capable model to index.');
      }
      if (failures.length > 0) {
        const shown = failures.slice(0, 5).join(', ');
        parts.push(`Could not read ${failures.length}: ${shown}${failures.length > 5 ? '…' : ''}.`);
      }
      setUploadStatus(parts.join(' '));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed to upload files');
      setUploadStatus(null);
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
  }

  async function handleSearch() {
    if (query.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await searchKnowledge(query.trim()));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'search failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ax__usage-overlay" role="dialog" aria-modal="true" aria-label="Knowledge base" onClick={onClose}>
      <div className="ax__usage ax__knowledge" onClick={(e) => e.stopPropagation()}>
        <header className="ax__usage-head">
          <div>
            <h2 className="ax__usage-title">Knowledge base</h2>
            <p className="ax__usage-sub">Upload documents or paste text — chat answers are grounded in it automatically.</p>
          </div>
          <button type="button" className="ax__iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        {error ? <div className="ax__alert" role="status">{error}</div> : null}

        <section className="ax__kb-upload">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.tsv,.txt,.md,.markdown,.json,.xml,.html,.htm,.log,.rtf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/*,image/*"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <button
            type="button"
            className="ax__kb-btn ax__kb-btn--upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Working…' : '⬆ Upload documents & images (PDF, Word, Excel, CSV, text, images)'}
          </button>
          <p className="ax__kb-hint">
            Drop in .pdf, .docx, .xlsx/.xls (all sheets, in full), .csv, .txt, .md, .json and
            images (.png/.jpg) — select 100+ files at once. Documents are extracted to text and
            images are read with OCR + description, then indexed automatically.
          </p>
          {uploadStatus ? <p className="ax__kb-status" role="status">{uploadStatus}</p> : null}
        </section>

        <div className="ax__kb-or">or paste text</div>

        <section className="ax__kb-add">
          <input
            className="ax__kb-input"
            placeholder="Source name (e.g. Refund Policy)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="ax__kb-textarea"
            placeholder="Paste the document or knowledge text here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
          />
          <button type="button" className="ax__kb-btn" onClick={() => void handleAdd()} disabled={busy}>
            {busy ? 'Indexing…' : '＋ Add & index source'}
          </button>
        </section>

        <section className="ax__kb-section">
          <h3 className="ax__kb-h3">Indexed sources ({sources.length})</h3>
          {sources.length === 0 ? (
            <p className="ax__usage-empty">No sources yet. Add one above to ground the assistant in your knowledge.</p>
          ) : (
            <ul className="ax__kb-list">
              {sources.map((s) => (
                <li key={s.id} className="ax__kb-item">
                  <span className="ax__kb-item-name">{s.name}</span>
                  <span className="ax__kb-item-meta">{s.chunk_count} chunks</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ax__kb-section">
          <h3 className="ax__kb-h3">Test retrieval</h3>
          <div className="ax__kb-search">
            <input
              className="ax__kb-input"
              placeholder="Ask something your knowledge should answer…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch();
              }}
            />
            <button type="button" className="ax__kb-btn" onClick={() => void handleSearch()} disabled={busy}>
              Search
            </button>
          </div>
          {hits !== null ? (
            hits.length === 0 ? (
              <p className="ax__usage-empty">No matches found.</p>
            ) : (
              <ul className="ax__kb-hits">
                {hits.map((h, i) => (
                  <li key={i} className="ax__kb-hit">
                    <div className="ax__kb-hit-head">
                      <span className="ax__kb-hit-title">{h.title}</span>
                      <span className="ax__kb-hit-score">{Math.round(h.score * 100)}%</span>
                    </div>
                    <p className="ax__kb-hit-text">{h.text.slice(0, 280)}{h.text.length > 280 ? '…' : ''}</p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}
