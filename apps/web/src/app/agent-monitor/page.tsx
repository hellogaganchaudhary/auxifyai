import { api } from '@/lib/api';
import type { AgentRunView } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Agent Monitor screen (Req 40.2).
 *
 * Observes live and historical agent runs in a data table, loaded through the
 * `@/lib/api` facade, with a status badge per run.
 */
function statusBadgeClass(status: AgentRunView['status']): string {
  switch (status) {
    case 'succeeded':
      return 'badge badge--success';
    case 'running':
    case 'queued':
      return 'badge badge--accent';
    case 'failed':
      return 'badge badge--danger';
    case 'cancelled':
      return 'badge badge--warning';
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default async function AgentMonitorPage() {
  const runs = await api.listAgentRuns();

  return (
    <div className="page">
      <PageHeader title="Agent Monitor" subtitle="Observe live and historical agent runs." />
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <caption className="sr-only">Agent runs</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Status</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
              <th scope="col">Steps</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{run.agentName}</td>
                <td>
                  <span className={statusBadgeClass(run.status)}>{run.status}</span>
                </td>
                <td>
                  <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                </td>
                <td>{formatDuration(run.durationMs)}</td>
                <td>{run.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
