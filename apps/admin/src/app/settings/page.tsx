export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedAdmin } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { SettingsForm } from './settings-form';
import { LegalDocumentsForm } from './legal-documents-form';

export default async function SettingsPage() {
  let player: Awaited<ReturnType<typeof getAuthenticatedAdmin>> | null = null;
  try {
    player = await getAuthenticatedAdmin();
  } catch {
    // Not authenticated or not admin — show limited settings
  }
  const supabase = createAdminClient();

  const { data: settings } = await supabase
    .from('platform_settings')
    .select('*')
    .order('key');

  const { data: legalDocuments } = await supabase
    .from('legal_documents')
    .select('document, version, content, updated_at')
    .order('document', { ascending: false }); // waiver first

  return (
    <div>
      <PageHeader
        title="Settings"
        sub="Manage your profile and platform configuration"
        watermark="S"
      />

      <div className="grid md:grid-cols-[210px_1fr] gap-10 items-start">
        {/* Section rail */}
        <nav className="settings-rail hidden md:flex">
          <a href="#general" className="active">
            <span className="rail-label block">General</span>
            <span className="rail-sub block">Profile &amp; platform</span>
          </a>
          {player?.role === 'admin' && (
            <a href="#legal">
              <span className="rail-label block">Legal Documents</span>
              <span className="rail-sub block">Waiver &amp; conduct</span>
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

          {/* Legal Documents */}
          {player?.role === 'admin' && legalDocuments && legalDocuments.length > 0 && (
            <section id="legal" className="scroll-mt-32">
              <h2 className="settings-section-title">Legal documents</h2>
              <p className="settings-section-desc">
                Shown to every member during onboarding. Bumping a version forces all members to re-accept before playing.
              </p>
              <LegalDocumentsForm documents={legalDocuments} />
            </section>
          )}

          {/* About */}
          <section id="about" className="scroll-mt-32">
            <h2 className="settings-section-title">About</h2>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">App version</div>
              </div>
              <div className="settings-row-control font-mono text-xs text-[var(--text-muted)]">v0.0.1</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
