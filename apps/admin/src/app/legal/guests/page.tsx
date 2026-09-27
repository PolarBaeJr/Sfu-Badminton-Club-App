export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Badge, Input, PageHeader } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { guestSearchFilter } from '@/lib/legal-signatures';

// WHO SIGNED AS AN EXTERNAL (00254). Read-only: a signing is never edited, voided
// or deleted from here.
//
// legal.page opens it, the key that opens /legal; SECTION_CAPABILITY matches
// the longest prefix, so this page inherits it with no map entry. It shows
// externals' emails, which the owner may later want behind players.read as well.
//
// Read with the service role, the only role 00254 grants SELECT to. The search
// matches the name or either version signed (see guestSearchFilter).

// TODO: replace with Tables<'guest_waiver_signings'> once prod has 00254 and
// database.gen.ts is regenerated.
type GuestSigningRow = {
  full_name: string;
  email: string;
  accepted_at: string;
  waiver_version: string;
  privacy_version: string;
};

const LIMIT = 500;

const TH =
  'px-5 pb-2 pt-4 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]';

export default async function GuestWaiversPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireCapability('legal.page');
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);

  const admin = createAdminClient();
  let query = admin
    .from('guest_waiver_signings')
    .select('full_name, email, accepted_at, waiver_version, privacy_version')
    .order('accepted_at', { ascending: false })
    .limit(LIMIT);
  if (q) query = query.or(guestSearchFilter(q));

  const [{ data, error }, { data: documents }] = await Promise.all([
    query,
    admin.from('legal_documents').select('document, version').in('document', ['waiver', 'privacy_policy']),
  ]);
  // A failed PostgREST read arrives as an empty list unless it is looked at,
  // and "nobody has signed" is exactly the wrong thing to show instead.
  if (error) console.error('[legal/guests] could not read the external signings:', error.message);
  const rows = (data ?? []) as GuestSigningRow[];
  const current = new Map((documents ?? []).map((d) => [d.document as string, d.version as string]));

  return (
    <div>
      <PageHeader
        eyebrow={`EXTERNAL WAIVERS · ${rows.length}${rows.length === LIMIT ? '+' : ''}`}
        title="External waivers"
        sub="Non-members who signed the waiver and privacy policy to play as an external."
        watermark="G"
      />

      <form method="get" className="mb-4 flex max-w-md gap-2">
        <Input name="q" defaultValue={q} placeholder="Search by name or version" aria-label="Search by name or version" />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-[var(--line)] px-4 text-sm text-[var(--text-primary)]"
        >
          Search
        </button>
      </form>

      {/* Card chrome from tokens rather than `.card-base`, which only the
          player app declares. Same note as ../page.tsx. */}
      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
        {error ? (
          <p role="alert" className="p-5 text-sm text-[var(--color-accent)]">
            The external signings could not be loaded: {error.message}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-[var(--text-muted)]">
            {q ? `No external signings match "${q}".` : 'No external has signed yet.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Email</th>
                <th className={TH}>Signed</th>
                <th className={TH}>Waiver</th>
                <th className={TH}>Privacy</th>
                <th className={TH}>Current</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isCurrent =
                  row.waiver_version === current.get('waiver') &&
                  row.privacy_version === current.get('privacy_policy');
                return (
                  <tr key={`${row.email}-${row.accepted_at}-${i}`} className="border-t border-[var(--line)]">
                    <td className="px-5 py-3 text-[var(--text-primary)]">{row.full_name}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{row.email}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-[var(--text-secondary)]">
                      {formatDateTime(row.accepted_at)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{row.waiver_version}</td>
                    <td className="px-5 py-3 font-mono text-xs">{row.privacy_version}</td>
                    <td className="px-5 py-3">
                      {isCurrent ? <Badge variant="success">Yes</Badge> : <Badge variant="warning">Outdated</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
