'use client';

/**
 * Contextual side panel for the application shell (Requirement 40.5).
 *
 * The right-hand panel renders one of three views for the current context:
 *   - `artifact`  — a preview of the artifact produced/selected in the main area
 *   - `web`       — web search results backing the current answer
 *   - `sources`   — full source attribution for retrieval-augmented content
 *
 * A small `ContextPanelProvider` holds which view is active and whether the
 * panel is open, so any screen can drive the panel (e.g. the chat screen can
 * surface citations) via the `useContextPanel` hook. Data is loaded through the
 * `@/lib/api` facade so the panel stays decoupled from the SDK's final surface.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import type { ArtifactPreview, WebResult } from '@/lib/api';
import type { SourceAttribution } from '@auxify/types';

/** The selectable views the contextual panel can show (Req 40.5). */
export type ContextView = 'artifact' | 'web' | 'sources';

/** Human-readable labels for each context view. */
const VIEW_LABELS: Record<ContextView, string> = {
  artifact: 'Artifact',
  web: 'Web results',
  sources: 'Sources',
};

/** The value exposed by the context-panel context. */
interface ContextPanelValue {
  /** Whether the panel is currently open. */
  open: boolean;
  /** The active view. */
  view: ContextView;
  /** Open the panel, optionally switching to a specific view. */
  openPanel: (view?: ContextView) => void;
  /** Close the panel. */
  closePanel: () => void;
  /** Toggle the panel open/closed. */
  togglePanel: () => void;
  /** Switch the active view (also ensures the panel is open). */
  setView: (view: ContextView) => void;
}

const ContextPanelContext = createContext<ContextPanelValue | null>(null);

/** Provider that holds contextual-panel open/view state for the whole shell. */
export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(true);
  const [view, setViewState] = useState<ContextView>('artifact');

  const openPanel = useCallback((next?: ContextView) => {
    setOpen(true);
    if (next) {
      setViewState(next);
    }
  }, []);
  const closePanel = useCallback(() => setOpen(false), []);
  const togglePanel = useCallback(() => setOpen((prev) => !prev), []);
  const setView = useCallback((next: ContextView) => {
    setViewState(next);
    setOpen(true);
  }, []);

  const value = useMemo<ContextPanelValue>(
    () => ({ open, view, openPanel, closePanel, togglePanel, setView }),
    [open, view, openPanel, closePanel, togglePanel, setView],
  );

  return <ContextPanelContext.Provider value={value}>{children}</ContextPanelContext.Provider>;
}

/** Access the contextual-panel controls. Throws if used outside the provider. */
export function useContextPanel(): ContextPanelValue {
  const context = useContext(ContextPanelContext);
  if (context === null) {
    throw new Error('useContextPanel must be used within a ContextPanelProvider');
  }
  return context;
}

/** Render the artifact-preview view. */
function ArtifactView() {
  const [artifact, setArtifact] = useState<ArtifactPreview | null>(null);

  useEffect(() => {
    let active = true;
    void api.getArtifactPreview().then((result) => {
      if (active) setArtifact(result);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!artifact) {
    return <p className="subtle">Loading artifact…</p>;
  }

  const body = typeof artifact.block.data === 'string' ? artifact.block.data : '';
  return (
    <article aria-label={`Artifact preview: ${artifact.title}`}>
      <h4>{artifact.title}</h4>
      <span className="badge badge--accent">{artifact.block.type}</span>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          marginTop: 'var(--space-3)',
          background: 'var(--surface-2)',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {body}
      </pre>
    </article>
  );
}

/** Render the web-results view. */
function WebView() {
  const [results, setResults] = useState<WebResult[]>([]);

  useEffect(() => {
    let active = true;
    void api.getWebResults().then((items) => {
      if (active) setResults(items);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ul className="list-plain stack" aria-label="Web search results">
      {results.map((result) => (
        <li key={result.id} className="card">
          <a href={result.url} className="card__title" target="_blank" rel="noreferrer">
            {result.title}
          </a>
          <p className="subtle">{result.url}</p>
          <p className="muted">{result.snippet}</p>
        </li>
      ))}
    </ul>
  );
}

/** Render the source-attribution view (Req 40.5, 24.4). */
function SourcesView() {
  const [sources, setSources] = useState<SourceAttribution[]>([]);

  useEffect(() => {
    let active = true;
    void api.getSourceAttributions().then((items) => {
      if (active) setSources(items);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ul className="list-plain stack" aria-label="Source attribution">
      {sources.map((source) => (
        <li key={source.sourceId} className="card">
          <a href={source.link} className="card__title">
            {source.sourceTitle}
          </a>
          <p className="card__meta">{source.location}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The contextual side panel itself. Rendered by `AppShell` as the right region;
 * hidden (via the `hidden` attribute) when closed so it is removed from the
 * accessibility tree.
 *
 * On tablet/mobile (`overlay` is `true`) the panel is presented as a sheet that
 * floats above the content rather than occupying a permanent grid column (Req
 * 41.1, 41.2); when open in overlay mode it gets a `dialog` role with an
 * accessible name and a backdrop scrim, and Escape / the scrim close it.
 */
export function ContextPanel({ overlay = false }: { overlay?: boolean }) {
  const { open, view, setView, closePanel } = useContextPanel();

  // In overlay mode, Escape closes the sheet (Req 41.4).
  useEffect(() => {
    if (!overlay || !open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePanel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlay, open, closePanel]);

  const overlayOpen = overlay && open;

  return (
    <>
      {overlayOpen ? (
        <div
          className="context-panel__scrim"
          aria-hidden="true"
          onClick={closePanel}
        />
      ) : null}
      <aside
        className="context-panel"
        data-overlay={overlay ? 'true' : 'false'}
        aria-label="Contextual panel"
        role={overlayOpen ? 'dialog' : undefined}
        aria-modal={overlayOpen ? true : undefined}
        hidden={!open}
      >
        <div className="context-panel__header">
          <h2 className="context-panel__title">Context</h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={closePanel}
            aria-label="Close contextual panel"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="context-panel__tabs" role="tablist" aria-label="Contextual views">
          {(Object.keys(VIEW_LABELS) as ContextView[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`context-tab-${candidate}`}
              aria-selected={view === candidate}
              aria-controls="context-panel-body"
              className="context-panel__tab"
              onClick={() => setView(candidate)}
            >
              {VIEW_LABELS[candidate]}
            </button>
          ))}
        </div>

        <div
          className="context-panel__body"
          id="context-panel-body"
          role="tabpanel"
          aria-labelledby={`context-tab-${view}`}
        >
          {view === 'artifact' && <ArtifactView />}
          {view === 'web' && <WebView />}
          {view === 'sources' && <SourcesView />}
        </div>
      </aside>
    </>
  );
}
