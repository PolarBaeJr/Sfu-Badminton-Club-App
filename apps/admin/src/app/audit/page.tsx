export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import Link from 'next/link';
import { AuditList, type AuditLogRow } from './audit-list';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const fullHistory = range === 'all';
  const supabase = createAdminClient();

  // Caps keep the payload bounded: 500 rows for the 30-day default,
  // 1000 for the full-history view (?range=all).
  let query = supabase
    .from('audit_logs')
    .select('*, actor:players!audit_logs_actor_id_fkey(full_name)')
    .order('created_at', { ascending: false })
    .limit(fullHistory ? 1000 : 500);

  if (!fullHistory) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', since);
  }

  const { data: logs } = await query;

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        eyebrow={fullHistory ? 'FULL HISTORY' : 'LAST 30 DAYS'}
        title="Audit Log"
        sub={
          <>
            Track all administrative actions.{' '}
            <Link
              href={fullHistory ? '/audit' : '/audit?range=all'}
              className="text-[var(--text-secondary)] underline underline-offset-4 hover:text-[var(--color-accent)]"
            >
              {fullHistory ? 'Last 30 days' : 'View full history'} →
            </Link>
          </>
        }
        watermark="A"
      />

      <AuditList logs={(logs ?? []) as AuditLogRow[]} />
    </div>
  );
}
