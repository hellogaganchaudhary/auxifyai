'use client';

/**
 * Agent Builder screen (Req 40.2).
 *
 * Lets the user design an agent (name, description, model, tools) on the left
 * while listing existing agents on the right. Existing agents are loaded
 * through the `@/lib/api` facade; the form is a local-state placeholder for the
 * eventual SDK create/update calls.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AgentSummary } from '@/lib/api';
import type { ModelInfo } from '@auxify/types';
import { PageHeader } from '@/components/ui/PageHeader';

export default function AgentBuilderPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.all([api.listAgents(), api.listModels()]).then(([loadedAgents, loadedModels]) => {
      if (!active) return;
      setAgents(loadedAgents);
      setModels(loadedModels);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="page">
      <PageHeader title="Agent Builder" subtitle="Design agents, tools, and multi-step workflows." />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card" aria-labelledby="agent-form-title">
          <h2 id="agent-form-title" className="card__title">
            New agent
          </h2>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              // Placeholder: a real implementation would call the SDK here.
            }}
          >
            <div className="stack" style={{ gap: 'var(--space-1)' }}>
              <label htmlFor="agent-name">Name</label>
              <input
                id="agent-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Research Assistant"
              />
            </div>
            <div className="stack" style={{ gap: 'var(--space-1)' }}>
              <label htmlFor="agent-description">Description</label>
              <textarea
                id="agent-description"
                className="textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should this agent do?"
              />
            </div>
            <div className="stack" style={{ gap: 'var(--space-1)' }}>
              <label htmlFor="agent-model">Model</label>
              <select id="agent-model" className="select">
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} ({model.tier})
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" style={{ alignSelf: 'flex-start' }}>
              Save agent
            </button>
          </form>
        </section>

        <section aria-labelledby="agent-list-title">
          <h2 id="agent-list-title">Existing agents</h2>
          <ul className="list-plain stack">
            {agents.map((agent) => (
              <li key={agent.id} className="card">
                <div className="row row--between">
                  <span className="card__title">{agent.name}</span>
                  <span className={agent.enabled ? 'badge badge--success' : 'badge'}>
                    {agent.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <p className="muted">{agent.description}</p>
                <div className="row row--wrap" style={{ gap: 'var(--space-1)' }}>
                  {agent.tools.map((tool) => (
                    <span key={tool} className="badge badge--accent">
                      {tool}
                    </span>
                  ))}
                </div>
                <p className="card__meta">Model: {agent.modelId}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
