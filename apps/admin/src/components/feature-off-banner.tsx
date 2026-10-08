import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase-server';
import { featureLabel, readFeatureFlags, type FeatureId } from '@badminton/shared';

// Drawn above a console page whose club feature is switched off. The page
// itself stays open: officers still need its history, and hiding it would make
// "where did tournaments go" unanswerable. The switch lives on /accounts, which
// is admin-only, so the pointer is worded for whoever reads it.
export async function FeatureOffBanner({ feature }: { feature: FeatureId }) {
  const features = await readFeatureFlags(createAdminClient());
  if (features[feature]) return null;

  return (
    <div
      role="status"
      className="mb-4 border border-[var(--red-border)] bg-[var(--red-wash)] px-4 py-3 text-[13px] leading-relaxed text-[var(--text-primary)]"
    >
      <strong className="text-[var(--color-accent)]">{featureLabel(feature)} is switched off for members.</strong>{' '}
      Members do not see it and cannot use it; everything here still works. An admin can switch it back on
      under{' '}
      <Link href="/accounts#account-rules" className="underline">
        Accounts, Club Features
      </Link>
      .
    </div>
  );
}
