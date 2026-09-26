export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { Badge, PageHeader } from '@badminton/ui';
import { clubDate } from '@badminton/shared';

// WHO ALLOWS THE CLUB TO USE PHOTOS OR VIDEO OF THEM (00255). Read-only: the
// choice is the member's or the guest's, never an officer's.
//
// legal.page opens it, as it opens /legal/guests, and it is NOT behind the
// guest_waivers switch: members' consent has nothing to do with it.
//
// The members half is the roster, so it is players.read, and like /legal the
// FETCH is skipped without it rather than the rows hidden after the fact.
// Members whose account is inactive, which includes a requested deletion, are
// left out. Guests show a name and a date only, never an email.

// TODO: replace with Tables<'guest_waiver_signings'> once prod has 00254 and
// database.gen.ts is regenerated.
type GuestConsentRow = {
  full_name: string;
  media_consent_changed_at: string | null;
};

type ConsentRow = {
  key: string;
  name: string;
  playerId: string | null;
  since: string | null;
};

const TH =
  'px-5 pb-2 pt-4 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]';

export default async function MediaConsentPage() {
  const viewer = await requireCapability('legal.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const canReadRoster = permits(level, permissions, 'players.read');

  const admin = createAdminClient();
  const [members, guests] = await Promise.all([
    canReadRoster
      ? admin
          .from('players')
          .select('id, full_name, media_consent_changed_at')
          .eq('media_consent', true)
          .eq('active_flag', true)
          .order('media_consent_changed_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    admin
      .from('guest_waiver_signings')
      .select('full_name, media_consent_changed_at')
      .eq('media_consent', true)
      .order('media_consent_changed_at', { ascending: false }),
  ]);
  // A failed PostgREST read arrives as an empty list unless it is looked at,
  // and "nobody has turned this on" is exactly the wrong thing to show instead.
  if (members.error) console.error('[legal/media-consent] could not read the members:', members.error.message);
  if (guests.error) console.error('[legal/media-consent] could not read the guests:', guests.error.message);
  const errors = [members.error, guests.error].filter((e) => e !== null);

  const rows: ConsentRow[] = [
    ...(members.data ?? []).map((m) => ({
      key: `m-${m.id}`,
      name: m.full_name ?? '',
      playerId: m.id,
      since: m.media_consent_changed_at,
    })),
    ...((guests.data ?? []) as GuestConsentRow[]).map((g, i) => ({
      key: `g-${i}`,
      name: g.full_name,
      playerId: null,
      since: g.media_consent_changed_at,
    })),
  ].sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''));

  return (
    <div>
      <PageHeader
        eyebrow={`PHOTO CONSENT · ${rows.length}`}
        title="Photo and video consent"
        sub="Members and guests who allow the club to use photos or video of them. Check here before you post."
        watermark="P"
      />

      {!canReadRoster && (
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Members are hidden because you cannot view the roster.
        </p>
      )}

      {/* Card chrome from tokens rather than `.card-base`, which only the
          player app declares. Same note as ../page.tsx. */}
      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
        {errors.length > 0 ? (
          <p role="alert" className="p-5 text-sm text-[var(--color-accent)]">
            The consent list could not be loaded: {errors.map((e) => e.message).join('; ')}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-[var(--text-muted)]">Nobody has turned this on yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Type</th>
                <th className={TH}>Allowed since</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)]">
                  <td className="px-5 py-3 text-[var(--text-primary)]">
                    {row.playerId ? (
                      <Link href={`/players/${row.playerId}`} className="hover:text-[var(--color-accent)]">
                        {row.name}
                      </Link>
                    ) : (
                      row.name
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {row.playerId ? <Badge variant="info">Member</Badge> : <Badge variant="neutral">Guest</Badge>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-[var(--text-secondary)]">
                    {row.since ? clubDate(row.since) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
