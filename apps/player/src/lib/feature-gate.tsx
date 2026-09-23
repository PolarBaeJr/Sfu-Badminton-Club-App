import { cache } from 'react';
import { redirect } from 'next/navigation';
import {
  ALL_FEATURES_ENABLED,
  ExpectedError,
  featureGate,
  featureLabel,
  featureAccessFor,
  featureOffMessage,
  readFeatureFlags,
  type FeatureFlags,
  type FeatureId,
} from '@badminton/shared';
import { createServiceRoleClient, getViewer } from './supabase-server';

// THE CLUB FEATURE SWITCHES, ON THE MEMBERS' SIDE. The registry and the
// decision are in packages/shared/src/utils/features.ts; this is where they
// meet a request.
//
// Read with the service-role client because two of the gated routes
// (/checkin/<token> and /tournaments/checkin) are reached signed out, and
// settings_select is `TO authenticated`. Never throws: a failed read, or a
// client that cannot be built, is every feature on.

/** The switches, once per request. */
export const getFeatureFlags = cache(async (): Promise<FeatureFlags> => {
  try {
    return await readFeatureFlags(createServiceRoleClient());
  } catch (err) {
    console.error('[features] could not build the settings client, treating all as on:', err);
    return { ...ALL_FEATURES_ENABLED };
  }
});

/**
 * Wraps a switchable feature's pages. A member is sent to the feed (a signed
 * out visitor to the home page) server-side; anyone holding the feature's
 * `page.access.<id>` key (an admin by level, anybody else by an explicit grant)
 * sees the page under a banner so they can check it before switching it back
 * on. Console access alone is not enough any more: that was 47fc75e7's rule,
 * and the club owner replaced it with a key that is granted per feature.
 */
export async function FeatureGate({
  feature,
  children,
}: {
  feature: FeatureId;
  children: React.ReactNode;
}) {
  const [flags, viewer] = await Promise.all([
    getFeatureFlags(),
    getViewer().catch(() => ({ user: null, player: null })),
  ]);
  const decision = featureGate(flags[feature], featureAccessFor(viewer.player).includes(feature));
  if (decision === 'redirect') redirect(viewer.user ? '/feed' : '/');

  return (
    <>
      {decision === 'banner' && (
        <div
          role="status"
          style={{
            borderBottom: '1px solid var(--red-border)',
            background: 'var(--red-wash)',
            color: 'var(--ink)',
            fontSize: 13,
            lineHeight: 1.5,
            padding: '10px 28px',
          }}
        >
          <div style={{ maxWidth: 'var(--page-max)', margin: '0 auto' }}>
            <strong style={{ color: 'var(--red)' }}>{featureLabel(feature)} is switched off for members.</strong>{' '}
            You can see it because you have been given access to it while it is off. Members are sent to the feed.
          </div>
        </div>
      )}
      {children}
    </>
  );
}

/**
 * Refuses a member's write on a feature that is switched off. Holders of the
 * feature's key pass, the same as on the pages, so whoever was let in can
 * still try the feature out. Called after requirePlayer(), with the row it
 * returned, which is `select('*')` and so carries the permission columns.
 */
export async function assertFeatureOn(
  feature: FeatureId,
  player: Parameters<typeof featureAccessFor>[0],
): Promise<void> {
  const flags = await getFeatureFlags();
  if (featureGate(flags[feature], featureAccessFor(player).includes(feature)) === 'redirect') {
    throw new ExpectedError(featureOffMessage(feature));
  }
}
