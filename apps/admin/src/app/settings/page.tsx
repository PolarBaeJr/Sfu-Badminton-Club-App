export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { SettingsForm } from './settings-form';
import { PasskeySection } from './passkey-section';

export default async function SettingsPage() {
  let player: Awaited<ReturnType<typeof getAuthenticatedConsoleUser>> | null = null;
  try {
    player = await getAuthenticatedConsoleUser();
  } catch {
    // Not authenticated or not exec/admin — show limited settings
  }
  const supabase = createAdminClient();

  const { data: settings } = await supabase
    .from('platform_settings')
    .select('*')
    .order('key');


  const { data: passkeys } = player
    ? await supabase
        .from('passkey_credentials')
        // enrolled_via (00051) travels with the row so this list and the
        // members'-app list show the SAME credentials described the same way,
        // and so the grace-period hint below can tell the truth: only
        // admin-enrolled credentials arm the console gate.
        .select('id, nickname, created_at, last_used_at, transports, enrolled_via')
        .eq('player_id', player.id)
        .order('created_at')
    : { data: null };

  return (
    <div>
      <PageHeader
        title="Settings"
        sub="Manage your profile and platform configuration"
        watermark="S"
      />

      <div className="grid md:grid-cols-[210px_1fr] gap-10 items-start">
        {/* Section rail */}
        <nav className="settings-rail hidden md:flex md:flex-col md:sticky md:top-6 md:self-start">
          <a href="#general" className="active">
            <span className="rail-label block">General</span>
            <span className="rail-sub block">Profile &amp; platform</span>
          </a>
          {player && (
            <a href="#security">
              <span className="rail-label block">Security</span>
              <span className="rail-sub block">Passkeys</span>
            </a>
          )}
          <a href="#about">
            <span className="rail-label block">About</span>
            <span className="rail-sub block">Version info</span>
          </a>
        </nav>

        <div className="space-y-14 min-w-0">
          {/* General */}
          <section id="general" className="scroll-mt-32">
            <h2 className="settings-section-title">General</h2>
            <p className="settings-section-desc">
              Your admin profile and platform-wide configuration.
            </p>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Name</div>
                <div className="settings-row-hint">Your full name as shown across the club.</div>
              </div>
              <div className="settings-row-control text-sm text-[var(--text-primary)]">{player?.full_name}</div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Email</div>
                <div className="settings-row-hint">The address you sign in with.</div>
              </div>
              <div className="settings-row-control text-sm text-[var(--text-primary)]">{player?.email}</div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Role</div>
                <div className="settings-row-hint">Controls which admin sections you can reach.</div>
              </div>
              <div className="settings-row-control text-sm text-[var(--text-primary)] capitalize">{player?.role}</div>
            </div>

            {player?.role === 'admin' && settings && (
              <SettingsForm settings={settings} />
            )}
          </section>

          {/* Security */}
          {player && (
            <section id="security" className="scroll-mt-32">
              <h2 className="settings-section-title">Security</h2>
              <p className="settings-section-desc">
                Passkeys gate access to the admin console. Once you enroll one, every login
                requires a passkey check.
              </p>
              <PasskeySection passkeys={passkeys ?? []} />
            </section>
          )}


          {/* About */}
          <section id="about" className="scroll-mt-32">
            <h2 className="settings-section-title">About</h2>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">App version</div>
              </div>
              <div className="settings-row-control font-mono text-xs text-[var(--text-muted)]">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
