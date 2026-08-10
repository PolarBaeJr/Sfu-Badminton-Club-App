export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { PlatformSettingsForm } from '@/components/platform-settings-form';
import { settingsForSection } from '@/lib/platform-setting-sections';

// The other half of the /settings split — see ./ratings/page.tsx for why both
// are admin-only with no exec read-only view. Accounts is also the catch-all:
// a platform_settings key with no entry in the section map lands here rather
// than disappearing from the console (see lib/platform-setting-sections.ts).
export default async function AccountsPage() {
  await requireCapability('accounts.read');

  const { data: settings } = await createAdminClient()
    .from('platform_settings')
    .select('*')
    .order('key');

  return (
    <div>
      <PageHeader
        title="Accounts"
        sub="What a member's account may do — challenges, match caps, no-shows, inactivity, check-in"
        watermark="A"
      />

      <div className="card-base">
        <PlatformSettingsForm settings={settingsForSection(settings ?? [], 'accounts')} />
      </div>
    </div>
  );
}
