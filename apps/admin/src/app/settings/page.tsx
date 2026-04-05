export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedAdmin } from '@/lib/supabase-server';
import { Card } from '@badminton/ui';
import { SettingsForm } from './settings-form';
import { Settings, User, Mail, Shield, Sliders, Info, ExternalLink } from 'lucide-react';

export default async function SettingsPage() {
  const player = await getAuthenticatedAdmin();
  const supabase = createAdminClient();

  const { data: settings } = await supabase
    .from('platform_settings')
    .select('*')
    .order('key');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent)]/10">
          <Settings className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">SETTINGS</h1>
          <p className="text-sm text-[var(--text-muted)]">Manage your profile and platform configuration</p>
        </div>
      </div>

      {/* Profile Section */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-8 h-8 rounded-lg bg-[var(--color-info)]/10 flex items-center justify-center">
            <User className="w-4 h-4 text-[var(--color-info)]" />
          </div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Profile</h2>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-elevated)]">
            <User className="w-4 h-4 text-[var(--text-muted)]" />
            <div>
              <p className="text-xs text-[var(--text-muted)]">Name</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">{player?.full_name}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-elevated)]">
            <Mail className="w-4 h-4 text-[var(--text-muted)]" />
            <div>
              <p className="text-xs text-[var(--text-muted)]">Email</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">{player?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-elevated)]">
            <Shield className="w-4 h-4 text-[var(--text-muted)]" />
            <div>
              <p className="text-xs text-[var(--text-muted)]">Role</p>
              <p className="text-sm font-medium text-[var(--text-primary)] capitalize">{player?.role}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Platform Settings */}
      {player?.role === 'admin' && settings && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center">
              <Sliders className="w-4 h-4 text-[var(--color-warning)]" />
            </div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Platform Settings</h2>
          </div>
          <SettingsForm settings={settings} />
        </div>
      )}

      {/* About */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-8 h-8 rounded-lg bg-[var(--text-muted)]/10 flex items-center justify-center">
            <Info className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">About</h2>
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
            <span className="text-[var(--text-muted)]">App Version</span>
            <span className="font-mono text-xs bg-[var(--color-accent)]/10 text-[var(--color-accent)] px-2 py-0.5 rounded-full">v0.0.1</span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
            <span className="text-[var(--text-muted)]">Supabase</span>
            <span className="text-[var(--text-primary)] font-mono text-xs truncate max-w-[250px] flex items-center gap-1.5">
              {process.env.NEXT_PUBLIC_SUPABASE_URL}
              <ExternalLink className="w-3 h-3 text-[var(--text-muted)]" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
