export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { PlatformSettingsForm } from '@/components/platform-settings-form';
import { settingsForSection } from '@/lib/platform-setting-sections';

// Split out of /settings, which is trainer-level so everyone can enrol their own
// passkeys. Platform configuration had no business living behind that gate.
//
// ratings.read is in no baseline, unlike legal.read: the club owner asked for
// these to be "separate from exec so they cant edit it", and unlike the legal
// documents there is nothing here an exec has a reason to read — so there is no
// read-only view. The route map only decides who may OPEN the section; this call
// is the page's own re-check, and updatePlatformSettings' platform.settings.write
// is the boundary that actually protects the data.
export default async function RatingsPage() {
  await requireCapability('ratings.read');

  const { data: settings } = await createAdminClient()
    .from('platform_settings')
    .select('*')
    .order('key');

  return (
    <div>
      <PageHeader
        title="Ratings"
        sub="Elo defaults, tournament bonuses and season compression"
        watermark="R"
      />

      <div className="card-base">
        <PlatformSettingsForm settings={settingsForSection(settings ?? [], 'ratings')} />
      </div>
    </div>
  );
}
