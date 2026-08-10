export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { EmptyState, PageHeader } from '@badminton/ui';

// WHO HOLDS CONSOLE ACCESS, AND WHAT THEY CAN DO WITH IT.
//
// Gated HERE as well as in permissions.ts: middleware decides who may open the
// route, but this page lists the club's privilege assignments, so it must not
// depend on middleware having been reached.
//
// READ-ONLY for now, and deliberately so. The portfolio editor that used to
// live here assigned one of four VP jobs; capabilities replaced it, and the
// editor that hands them out ships with the storage migration — there is
// nowhere to write a capability to yet. permissions.read is in no baseline, so
// this page is admin-only exactly as it was.
export default async function PermissionsPage() {
  await requireCapability('permissions.read');

  const { data: execs } = await createAdminClient()
    .from('players')
    .select('id, full_name, email, exec_title')
    .eq('is_exec', true)
    .order('full_name');

  return (
    <div>
      <PageHeader
        title="Permissions"
        sub="Who holds executive access to this console"
        watermark="P"
      />

      {(execs?.length ?? 0) === 0 ? (
        <EmptyState title="No executives" description="Nobody on the roster is marked as an exec." />
      ) : (
        <div className="card-base">
          <p className="settings-section-desc">
            Every executive currently holds the full executive baseline. Handing out individual
            permissions arrives with the next change.
          </p>
          {(execs ?? []).map((exec) => (
            <div key={exec.id as string} className="settings-row">
              <div>
                <div className="settings-row-label">
                  {(exec.full_name as string | null) ?? (exec.email as string | null) ?? 'Unnamed'}
                </div>
                <div className="settings-row-hint">
                  {(exec.exec_title as string | null) ?? 'Executive'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
