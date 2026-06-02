import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Admin Panel screen (Req 40.2).
 *
 * Manages platform members, showing each member's role and active status in a
 * data table loaded through the `@/lib/api` facade. Roles reuse the shared
 * `Role` type from `@auxify/types`.
 */
export default async function AdminPage() {
  const members = await api.listMembers();

  return (
    <div className="page">
      <PageHeader
        title="Admin Panel"
        subtitle="Manage organizations, teams, members, and policies."
        actions={
          <button type="button" className="btn btn--primary">
            <span aria-hidden="true">＋</span> Invite member
          </button>
        }
      />
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <caption className="sr-only">Platform members</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td>{member.name}</td>
                <td className="subtle">{member.email}</td>
                <td>
                  <span className="badge">{member.role.replace('_', ' ')}</span>
                </td>
                <td>
                  <span className={member.active ? 'badge badge--success' : 'badge badge--danger'}>
                    {member.active ? 'active' : 'inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
