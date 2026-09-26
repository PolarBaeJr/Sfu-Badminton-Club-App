import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@badminton/ui';
import { clubDate } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';

// A guest's proof of signing. The token is a bearer link, like a calendar feed
// token: whoever holds it sees the name, the date and the two versions, and
// never the email, the user agent or the IP hash.
//
// DELIBERATELY NOT BEHIND THE FEATURE SWITCH. A proof already handed out must
// keep working after the club switches guest waivers off.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const TOKEN = /^[0-9a-f]{48}$/;

// TODO: replace with Tables<'guest_waiver_signings'> once prod has 00254 and
// database.gen.ts is regenerated.
type GuestWaiverProof = {
  full_name: string;
  accepted_at: string;
  waiver_version: string;
  privacy_version: string;
};

export default async function GuestWaiverProofPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();

  // Service role: it is the only role granted SELECT on this table (00254).
  const { data, error } = await createServiceRoleClient()
    .from('guest_waiver_signings')
    .select('full_name, accepted_at, waiver_version, privacy_version')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`Could not read the guest waiver signing: ${error.message}`);
  const row = data as GuestWaiverProof | null;
  if (!row) notFound();

  return (
    <div data-screen-label="Guest waiver proof" style={{ maxWidth: 760, margin: '0 auto' }}>
      <PageHeader eyebrow="GUEST WAIVER" title={row.full_name} sub="Signed as a guest of SFU Badminton Club." />
      <dl className="card-base" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', margin: 0 }}>
        <dt className="muted">Signed</dt>
        <dd style={{ margin: 0 }}>{clubDate(row.accepted_at)}</dd>
        <dt className="muted">Liability Waiver</dt>
        <dd style={{ margin: 0 }}>Version {row.waiver_version}</dd>
        <dt className="muted">Privacy Policy</dt>
        <dd style={{ margin: 0 }}>Version {row.privacy_version}</dd>
      </dl>
    </div>
  );
}
