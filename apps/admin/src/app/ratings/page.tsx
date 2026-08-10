export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { PageHeader } from '@badminton/ui';
import { PlatformSettingsForm } from '@/components/platform-settings-form';
import { settingsForSection } from '@/lib/platform-setting-sections';

// Split out of /settings, which is trainer-level so everyone can enrol their own
// passkeys. Platform configuration had no business living behind that gate.
//
// ratings.page is in no baseline, unlike legal.page: the club owner asked for
// these to be "separate from exec so they cant edit it", and unlike the legal
// documents there is nothing here an exec has a reason to read — so there is no
// read-only view. The route map only decides who may OPEN the section; this call
// is the page's own re-check, and updatePlatformSettings' platform.settings.write
// is the boundary that actually protects the data.
//
// THE FORM IS ITS OWN AREA. `platform` has no route of its own — the settings it
// holds are drawn here and on /accounts — so platform.page is what gates the
// form, and the query behind it, on both pages. Opening Ratings and editing the
// platform's rating rules are two permissions, and today's answer is unchanged
// because only an admin holds either.
export default async function RatingsPage() {
  const viewer = await requireCapability('ratings.page');
  const showPlatformSettings = permits(
    accessLevelFor(viewer),
    permissionsOf(viewer),
    'platform.page',
  );

  const { data: settings } = showPlatformSettings
    ? await createAdminClient().from('platform_settings').select('*').order('key')
    : { data: null };

  return (
    <div>
      <PageHeader
        title="Ratings"
        sub="Elo defaults, tournament bonuses and season compression"
        watermark="R"
      />

      {showPlatformSettings && (
        <div className="card-base">
          <PlatformSettingsForm settings={settingsForSection(settings ?? [], 'ratings')} />
        </div>
      )}
    </div>
  );
}
