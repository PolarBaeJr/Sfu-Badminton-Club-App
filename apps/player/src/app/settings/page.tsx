'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Input, Textarea, Switch, PageHeader, Dialog } from '@badminton/ui';
import { updateProfile, deleteMyAccount } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { AvatarUpload } from '@/components/AvatarUpload';
import { CalendarFeed } from './calendar-feed';
import {
  User,
  Calendar,
  Moon,
  Sun,
  Monitor,
  Bell,
  BellOff,
  Shield,
  LogOut,
  Info,
  Check,
  Save,
  Palette,
  Loader2,
  Receipt,
  ChevronRight,
  Trash2,
} from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

const themeOptions: { value: Theme; icon: React.ElementType; label: string }[] = [
  { value: 'light',  icon: Sun,     label: 'Light' },
  { value: 'dark',   icon: Moon,    label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <Icon size={16} className="text-[var(--mute)]" />
        <h3 className="settings-section-title" style={{ margin: 0 }}>{title}</h3>
      </div>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setThemeState] = useState<Theme>('dark');
  const [showOnLeaderboard, setShowOnLeaderboard] = useState(true);
  const [showActivity, setShowActivity] = useState(true);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isExec, setIsExec] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('players').select('*').eq('user_id', user.id).maybeSingle();
      if (data) {
        setPlayerId(data.id);
        setAvatarUrl(data.avatar_url);
        setName(data.full_name);
        setDisplayName(data.display_name || '');
        setPhone(data.phone || '');
        setBio(data.bio || '');
        setShowOnLeaderboard(!data.hide_from_leaderboard);
        setShowActivity(data.show_activity_status !== false);
        setIsExec(data.is_exec || data.role === 'admin');
        setLoaded(true);
      }
    }
    load();
    const saved = (localStorage.getItem('theme') as Theme) || 'dark';
    setThemeState(saved);
    // Migrate existing localStorage-only users to the cookie so SSR picks it up.
    if (!/(?:^|; )theme=/.test(document.cookie)) {
      document.cookie = `theme=${saved}; path=/; max-age=31536000; samesite=lax`;
    }
    setPushSupported(isPushSupported());
    isPushEnabled().then(setPushEnabled);
  }, []);

  function handleThemeChange(newTheme: Theme) {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    // Also persist to a cookie so the server can set data-theme on first paint
    // (no flash). 1-year expiry, lax so it rides normal navigations.
    document.cookie = `theme=${newTheme}; path=/; max-age=31536000; samesite=lax`;
    const resolved = newTheme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : newTheme;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await updateProfile({
        full_name: name,
        display_name: displayName || undefined,
        phone: phone || undefined,
        bio: bio || undefined,
        hide_from_leaderboard: !showOnLeaderboard,
        show_activity_status: showActivity,
      });
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      setSaved(true);
      toast('Profile updated', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handlePushToggle(enabled: boolean) {
    setPushLoading(true);
    try {
      if (enabled) {
        const ok = await subscribeToPush(playerId);
        if (ok) {
          setPushEnabled(true);
          toast('Push notifications enabled', 'success');
        } else {
          toast('Could not enable push notifications', 'error');
        }
      } else {
        await unsubscribeFromPush(playerId);
        setPushEnabled(false);
        toast('Push notifications disabled', 'info');
      }
    } catch {
      toast('Failed to update push settings', 'error');
    }
    setPushLoading(false);
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  async function handleDeleteAccount() {
    setDeleteLoading(true);
    try {
      const res = await deleteMyAccount(deleteConfirm);
      if (!res.ok) {
        toast(res.error, 'error');
        setDeleteLoading(false);
        return;
      }
      // Best-effort sign out, then a hard redirect — router state is stale
      // after the account is scheduled for deletion.
      const supabase = createClient();
      await supabase.auth.signOut();
      window.location.href = '/';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete account', 'error');
      setDeleteLoading(false);
    }
  }

  return (
    <div data-screen-label="Settings" style={{ maxWidth: 1120, margin: '0 auto' }}>
      <PageHeader
        title="Settings"
      />

      {!loaded ? (
        <div className="feed-col">
          <div className="skeleton" style={{ height: 220, borderRadius: 'var(--r-lg)' }} />
          <div className="skeleton" style={{ height: 120, borderRadius: 'var(--r-lg)' }} />
        </div>
      ) : (
        <div className="feed-col">
          <Section icon={User} title="Profile">
            {playerId && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
                <AvatarUpload
                  playerId={playerId}
                  playerName={name}
                  currentUrl={avatarUrl}
                  onUploaded={setAvatarUrl}
                />
              </div>
            )}
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input label="Full name"           value={name}        onChange={(e) => setName(e.target.value)} required />
              <Input label="Display name / nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" />
              <Input label="Phone"               value={phone}       onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+\-()]/g, ''))} placeholder="Optional" inputMode="tel" />
              <Textarea label="Bio"              value={bio}         onChange={(e) => setBio(e.target.value)} placeholder="A few words about yourself" />
              <button
                type="submit"
                disabled={loading}
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
                {loading ? 'Saving…' : saved ? 'Saved' : 'Save profile'}
              </button>
            </form>
          </Section>

          <Section icon={Receipt} title="Fees & Dues">
            <Link
              href="/fees"
              className="settings-row settings-row-nav"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="settings-row-label">View what I owe</div>
                <div className="settings-row-hint">Club and tournament fees for the current season.</div>
              </div>
              <div className="settings-row-control">
                <ChevronRight size={16} className="text-[var(--mute)]" />
              </div>
            </Link>
          </Section>

          <Section icon={Calendar} title="Calendar">
            <CalendarFeed />
          </Section>

          <Section icon={Palette} title="Appearance">
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>Choose your preferred theme.</p>
            <div className="grid grid-3" style={{ gap: 10 }}>
              {themeOptions.map(({ value, icon: Icon, label }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleThemeChange(value)}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      padding: '16px 12px',
                      borderRadius: 0,
                      border: '1px solid ' + (active ? 'var(--red)' : 'var(--line)'),
                      background: active ? 'var(--red-wash)' : 'var(--surface)',
                      color: active ? 'var(--red)' : 'var(--ink-2)',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all .15s',
                    }}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                    {active && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -6,
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          background: 'var(--red)',
                          color: '#fff',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        <Check size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section icon={Bell} title="Notifications">
            {pushSupported ? (
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                {pushEnabled ? <Bell size={16} className="text-[var(--red)]" style={{ marginTop: 2 }} /> : <BellOff size={16} className="text-[var(--mute)]" style={{ marginTop: 2 }} />}
                <div style={{ flex: 1 }}>
                  <Switch
                    checked={pushEnabled}
                    onChange={handlePushToggle}
                    label="Push notifications"
                    description="Get notified about challenges, results, and announcements."
                    disabled={pushLoading}
                  />
                </div>
              </div>
            ) : (
              <div className="row" style={{ gap: 10, padding: 12, background: 'var(--surface-2)' }}>
                <BellOff size={14} className="text-[var(--mute)]" />
                <span className="muted" style={{ fontSize: 13 }}>Push notifications not supported in this browser.</span>
              </div>
            )}
          </Section>

          <Section icon={Shield} title="Privacy">
            <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>Saved when you tap <strong>Save profile</strong>.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Switch
                checked={showOnLeaderboard}
                onChange={setShowOnLeaderboard}
                label="Show on leaderboard"
                description="Your rank will be visible to others."
              />
              <div className="sep" />
              <Switch
                checked={showActivity}
                onChange={setShowActivity}
                label="Show activity status"
                description="Others can see when you were last active."
              />
            </div>
          </Section>

          <Section icon={Info} title="About">
            <div className="settings-row">
              <div className="settings-row-label">Version</div>
              <div className="settings-row-control">
                <span className="mono tag">0.0.1</span>
              </div>
            </div>
          </Section>

          <Section icon={LogOut} title="Account">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Sign out</div>
                <div className="settings-row-hint">End your session on this device.</div>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="btn btn-ghost"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </div>
          </Section>

          <div className="danger-zone">
            <h3 className="danger-title">Danger zone</h3>
            {isExec && (
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">EXEC PANEL</div>
                  <div className="settings-row-hint">Open the club administration panel.</div>
                </div>
                <div className="settings-row-control">
                  <a
                    href={process.env.NEXT_PUBLIC_ADMIN_URL || '/admin'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-danger-ghost"
                  >
                    <Shield size={14} />
                    OPEN EXEC PANEL
                  </a>
                </div>
              </div>
            )}
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Delete account</div>
                <div className="settings-row-hint">
                  Permanently deletes your login and removes your personal information
                  after a 30-day grace period. Your match and rating history stays under
                  an anonymous name.
                </div>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  onClick={() => setShowDeleteDialog(true)}
                  className="btn btn-danger-ghost"
                >
                  <Trash2 size={14} />
                  Delete account
                </button>
              </div>
            </div>
          </div>

          <Dialog
            open={showDeleteDialog}
            onClose={() => { setShowDeleteDialog(false); setDeleteConfirm(''); }}
            title="Delete account"
          >
            <div className="space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Your account is deactivated and hidden immediately. Sign back in any time
                within 30 days to restore it. After 30 days your login is permanently
                removed and your personal information is deleted — your match and rating
                history remains under an anonymous name.
              </p>
              <Input
                label="Type DELETE to confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
              />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setShowDeleteDialog(false); setDeleteConfirm(''); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={deleteConfirm !== 'DELETE' || deleteLoading}
                  onClick={handleDeleteAccount}
                >
                  {deleteLoading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Delete account
                </button>
              </div>
            </div>
          </Dialog>
        </div>
      )}
    </div>
  );
}
