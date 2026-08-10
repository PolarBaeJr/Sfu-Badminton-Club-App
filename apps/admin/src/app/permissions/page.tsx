export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedAdmin } from '@/lib/supabase-server';
import { EmptyState, PageHeader } from '@badminton/ui';
import { PortfolioEditor } from './portfolio-editor';

// WHO HOLDS WHICH EXEC PORTFOLIO.
//
// Admin-only, and gated HERE as well as in permissions.ts: middleware decides
// who may open the route, but this page lists the club's privilege assignments
// and hands out the control that changes them, so it must not depend on
// middleware having been reached. setPlayerPortfolio() gates again on its own —
// that one is the boundary; this is what stops the page rendering at all.
//
// Execs only. A portfolio narrows an exec, so on an admin (superuser) or a
// trainer (holds none) it would be a control that does nothing — see
// setPlayerPortfolio(), which refuses those rows for the same reason.
export default async function PermissionsPage() {
  await getAuthenticatedAdmin();

  const { data: execs } = await createAdminClient()
    .from('players')
    .select('id, full_name, email, exec_title, portfolio')
    .eq('is_exec', true)
    .order('full_name');

  return (
    <div>
      <PageHeader
        title="Permissions"
        sub="Which part of the club each executive runs — and therefore which sections of this console they can open"
        watermark="P"
      />

      {(execs?.length ?? 0) === 0 ? (
        <EmptyState title="No executives" description="Nobody on the roster is marked as an exec." />
      ) : (
        <div className="card-base">
          <PortfolioEditor
            execs={(execs ?? []).map((e) => ({
              id: e.id as string,
              full_name: (e.full_name as string | null) ?? null,
              email: (e.email as string | null) ?? null,
              exec_title: (e.exec_title as string | null) ?? null,
              portfolio: (e.portfolio as string | null) ?? null,
            }))}
          />
        </div>
      )}
    </div>
  );
}
