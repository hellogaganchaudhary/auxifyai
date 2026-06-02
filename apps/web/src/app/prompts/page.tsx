import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Prompt Library screen (Req 40.2).
 *
 * Lists reusable, parameterized prompt templates loaded through the `@/lib/api`
 * facade. Each card shows the template's purpose, its variables, and tags.
 */
export default async function PromptsPage() {
  const prompts = await api.listPrompts();

  return (
    <div className="page">
      <PageHeader
        title="Prompt Library"
        subtitle="Reusable, parameterized prompt templates."
        actions={
          <button type="button" className="btn btn--primary">
            <span aria-hidden="true">＋</span> New template
          </button>
        }
      />
      <div className="grid grid--cards" role="list" aria-label="Prompt templates">
        {prompts.map((prompt) => (
          <article key={prompt.id} className="card" role="listitem">
            <h2 className="card__title">{prompt.title}</h2>
            <p className="muted">{prompt.description}</p>
            <div className="row row--wrap" style={{ gap: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
              {prompt.variables.map((variable) => (
                <code key={variable} className="kbd">{`{${variable}}`}</code>
              ))}
            </div>
            <div className="row row--wrap" style={{ gap: 'var(--space-1)' }}>
              {prompt.tags.map((tag) => (
                <span key={tag} className="badge">
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
