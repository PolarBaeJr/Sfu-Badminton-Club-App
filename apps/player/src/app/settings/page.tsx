'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Input, Textarea, Switch, Select, PageHeader, Dialog } from '@badminton/ui';
import { updateProfile, updateNotificationPreferences, deleteMyAccount } from '@/lib/actions';
import { NOTIFICATION_CATEGORIES, normalizeNotificationPreferences, normalizeEmailPreferences, emailPreferenceKey, joinName, getReminderLeadMinutes, REMINDER_LEAD_MIN_MINUTES, REMINDER_LEAD_MAX_MINUTES, clearHostOnlyAuthCookies, hasConsoleAccess, getAccountStanding, type NotificationCategory } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { AvatarUpload } from '@/components/AvatarUpload';
import { CalendarFeed } from './calendar-feed';
import { PasskeyManager } from '@/components/passkey-manager';
import {
  User,
  Calendar,
  Moon,
  Sun,
  Monitor,
  Bell,
  BellOff,
  KeyRound,
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
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
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
  const [notifPrefs, setNotifPrefs] = useState<Record<NotificationCategory, boolean>>(
    () => normalizeNotificationPreferences({}),
  );
  // Email is tracked separately from push: they are different enough that one
  // switch for both is wrong — push is a phone buzzing mid-match, email is
  // something you read later.
  const [emailPrefs, setEmailPrefs] = useState<Record<NotificationCategory, boolean>>(
    () => normalizeEmailPreferences({}),
  );
  // Free-form: a number plus a unit, stored as minutes.
  const [leadValue, setLeadValue] = useState('2');
  const [leadUnit, setLeadUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [playerId, setPlayerId] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // TWO different questions, deliberately kept apart:
  //   isExec         — is this person on the club exec? Drives the note about
  //                    their bio being published on the public /exec page (00042).
  //                    A varsity trainer is NOT an exec and their bio is private.
  //   canOpenConsole — may this person open the admin console at all? Trainers
  //                    can, so this is strictly wider than isExec.
  const [isExec, setIsExec] = useState(false);
  const [canOpenConsole, setCanOpenConsole] = useState(false);
  // Fees and the calendar feed are member features the server rejects unless
  // the account is in good standing (requirePlayer throws "Account pending
  // approval" / "Account suspended"), so showing them just produced a dead
  // panel. getAccountStanding is the same three checks requirePlayer makes —
  // the hand-rolled status test this replaced missed is_banned entirely.
  const [isApproved, setIsApproved] = useState(true);
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
      // players_self is filtered to auth.uid() server-side, so it returns only
      // this user's row — including the phone and notification preferences that
      // 00032 withholds from the plain players grant.
      const { data } = await supabase.from('players_self').select('*').maybeSingle();
      if (data) {
        setPlayerId(data.id);
        setAvatarUrl(data.avatar_url);
        setFirstName(data.first_name);
        setLastName(data.last_name || '');
        setDisplayName(data.display_name || '');
        setPhone(data.phone || '');
        setBio(data.bio || '');
        setShowOnLeaderboard(!data.hide_from_leaderboard);
        setShowActivity(data.show_activity_status !== false);
        setNotifPrefs(normalizeNotificationPreferences(data.notification_preferences));
        setEmailPrefs(normalizeEmailPreferences(data.notification_preferences));
        const mins = getReminderLeadMinutes(data.notification_preferences);
        // Show it back in the largest unit that divides evenly, so "120" reads
        // as "2 hours" rather than a raw minute count.
        if (mins % 1440 === 0) { setLeadValue(String(mins / 1440)); setLeadUnit('days'); }
        else if (mins % 60 === 0) { setLeadValue(String(mins / 60)); setLeadUnit('hours'); }
        else { setLeadValue(String(mins)); setLeadUnit('minutes'); }
        setIsExec(data.is_exec || data.role === 'admin');
        // The SAME predicate the top bar uses (layout.tsx) and the same one the
        // console itself enforces — never a second hand-rolled boolean. This
        // page used to test `is_exec || role === 'admin'`, which predates the
        // varsity trainer role, so trainers saw the console link in the top bar
        // and nothing here. players_self is `SELECT *`, so the standing columns
        // hasConsoleAccess needs (is_banned, status, active_flag) are present.
        setCanOpenConsole(hasConsoleAccess(data));
        // getAccountStanding, not a hand-rolled status test: the old one missed
        // is_banned, so a banned member kept every control on this page.
        setIsApproved(getAccountStanding(data).ok);
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
        first_name: firstName,
        last_name: lastName || undefined,
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

  const leadMinutes =
    (Number(leadValue) || 0) * (leadUnit === 'days' ? 1440 : leadUnit === 'hours' ? 60 : 1);
  const leadInvalid =
    !leadValue || leadMinutes < REMINDER_LEAD_MIN_MINUTES || leadMinutes > REMINDER_LEAD_MAX_MINUTES;

  async function saveReminderLead(minutes: number) {
    if (leadInvalid) return;
    const res = await updateNotificationPreferences({ ...notifPrefs, session_reminder_lead_minutes: minutes });
    if (!res.ok) toast(res.error, 'error');
  }

  async function handleEmailPrefToggle(category: NotificationCategory, value: boolean) {
    const previous = emailPrefs;
    const next = { ...emailPrefs, [category]: value };
    setEmailPrefs(next); // optimistic
    // Sent under the `email_` prefix the server whitelists. The action merges
    // onto the stored blob, so this cannot clobber the push toggles.
    const res = await updateNotificationPreferences(
      Object.fromEntries(
        Object.entries(next).map(([k, v]) => [emailPreferenceKey(k as NotificationCategory), v]),
      ),
    );
    if (!res.ok) {
      setEmailPrefs(previous); // revert
      toast(res.error, 'error');
    }
  }

  async function handleNotifPrefToggle(category: NotificationCategory, value: boolean) {
    const previous = notifPrefs;
    const next = { ...notifPrefs, [category]: value };
    setNotifPrefs(next); // optimistic
    const res = await updateNotificationPreferences(next);
    if (!res.ok) {
      setNotifPrefs(previous); // revert
      toast(res.error, 'error');
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // The library's own sign-out only clears the cookie on its configured
    // scope; a leftover host-only copy from before the switch would still be a
    // valid session. No-op once no such copy exists.
    clearHostOnlyAuthCookies();
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
      clearHostOnlyAuthCookies();
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
                  playerName={joinName(firstName, lastName)}
                  currentUrl={avatarUrl}
                  onUploaded={setAvatarUrl}
                />
              </div>
            )}
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input label="First name"          value={firstName}   onChange={(e) => setFirstName(e.target.value)} required />
              <Input label="Last name"           value={lastName}    onChange={(e) => setLastName(e.target.value)} placeholder="Optional" />
              <Input label="Display name / nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" />
              <Input label="Phone"               value={phone}       onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+\-()]/g, ''))} placeholder="Optional" inputMode="tel" />
              <Textarea label="Bio"              value={bio}         onChange={(e) => setBio(e.target.value)} placeholder="A few words about yourself" />
              {/* Execs only: their bio is published on the public /exec page
                  (00042). Saying so here matters — the field predates that page
                  by a long way, so an exec may have written it expecting it to
                  stay private. */}
              {isExec && (
                <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
                  As an exec, your bio is shown publicly on the club&apos;s exec page.
                </p>
              )}
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

          {isApproved && (
            <Section icon={Calendar} title="Calendar">
              <CalendarFeed />
            </Section>
          )}

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

          {/* Push and email are the SAME five categories, chosen separately and
              laid out identically. Push used to be one blanket switch —
              "challenges, results, and announcements" — which meant the only way
              to stop one kind of buzz was to stop all of them, while email had
              had per-category control for a while. Two channels, one list. */}
          <Section icon={Bell} title="Notifications">
            <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 14 }}>
              Everything here starts off. Turn on whatever you want to hear about —
              the in-app inbox keeps a copy either way, so nothing is lost.
            </p>

            <div className="card-head" style={{ marginBottom: 10 }}>
              <h3 className="card-title" style={{ fontSize: 15 }}>Push</h3>
            </div>
            {pushSupported ? (
              <>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  {pushEnabled ? <Bell size={16} className="text-[var(--red)]" style={{ marginTop: 14 }} /> : <BellOff size={16} className="text-[var(--mute)]" style={{ marginTop: 14 }} />}
                  <div style={{ flex: 1 }}>
                    <Switch
                      checked={pushEnabled}
                      onChange={handlePushToggle}
                      label="Allow push on this device"
                      description="Needed before any push can reach this browser."
                      disabled={pushLoading}
                    />
                  </div>
                </div>
                <div className="sep" />
                {/* Same list, same order, same labels as the email block below.
                    Always live, never disabled: the switch above is about THIS
                    browser's subscription, while these five are stored on the
                    account and apply to every device. Greying them out because
                    the laptop you happen to be on is not subscribed would hide
                    an account-wide setting behind a per-device one. */}
                {NOTIFICATION_CATEGORIES.map((c, i) => (
                  <div key={c.key}>
                    {i > 0 && <div className="sep" />}
                    <Switch
                      checked={notifPrefs[c.key]}
                      onChange={(v) => handleNotifPrefToggle(c.key, v)}
                      label={c.label}
                      description={c.description}
                    />
                  </div>
                ))}
                {!pushEnabled && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    These apply to every device you allow push on — this browser is not one of them yet.
                  </p>
                )}

                {/* Also account-wide, so it is not hidden behind this device's
                    subscription either. */}
                <div className="sep" />
                <div style={{ marginTop: 4 }}>
                      <label className="eyebrow block mb-2">Remind me before a session</label>
                      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <Input
                          aria-label="Amount"
                          type="text"
                          inputMode="numeric"
                          value={leadValue}
                          onChange={(e) => setLeadValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          onBlur={() => saveReminderLead(leadMinutes)}
                          style={{ maxWidth: 96 }}
                        />
                        <Select
                          aria-label="Unit"
                          value={leadUnit}
                          onChange={(e) => {
                            const u = e.target.value as 'minutes' | 'hours' | 'days';
                            setLeadUnit(u);
                            const m = (Number(leadValue) || 0) * (u === 'days' ? 1440 : u === 'hours' ? 60 : 1);
                            if (m >= REMINDER_LEAD_MIN_MINUTES && m <= REMINDER_LEAD_MAX_MINUTES) saveReminderLead(m);
                          }}
                          options={[
                            { value: 'minutes', label: 'minutes before' },
                            { value: 'hours', label: 'hours before' },
                            { value: 'days', label: 'days before' },
                          ]}
                        />
                      </div>
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        {leadInvalid
                          ? 'Pick anything from 5 minutes to 7 days.'
                          : "Only for sessions you said you're going to, and only if they have a start time."}
                      </p>
                </div>
              </>
            ) : (
              <div className="row" style={{ gap: 10, padding: 12, background: 'var(--surface-2)' }}>
                <BellOff size={14} className="text-[var(--mute)]" />
                <span className="muted" style={{ fontSize: 13 }}>Push notifications not supported in this browser.</span>
              </div>
            )}

            {/* Outside the push check on purpose: email works whether or not
                this browser supports push, and burying these behind that check
                would leave someone with no way to stop the mail. */}
            <div className="sep" />
            <div className="card-head" style={{ marginBottom: 10 }}>
              <h3 className="card-title" style={{ fontSize: 15 }}>Email</h3>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
              Sign-in codes are always sent — you need them to get into your account.
            </p>
            {NOTIFICATION_CATEGORIES.map((c, i) => (
              <div key={`email-${c.key}`}>
                {i > 0 && <div className="sep" />}
                <Switch
                  checked={emailPrefs[c.key]}
                  onChange={(v) => handleEmailPrefToggle(c.key, v)}
                  label={c.label}
                  description={c.description}
                />
              </div>
            ))}
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

          <Section icon={KeyRound} title="Passkeys">
            <PasskeyManager />
          </Section>

          <Section icon={Info} title="About">
            <div className="settings-row">
              <div className="settings-row-label">Version</div>
              <div className="settings-row-control">
                <span className="mono tag">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
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
            {canOpenConsole && (
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">EXEC PANEL</div>
                  <div className="settings-row-hint">Open the club administration panel.</div>
                </div>
                <div className="settings-row-control">
                  {/* See top-bar.tsx: same-origin, plain <a>, and no
                      target="_blank" — a new tab would eject the exec from the
                      installed PWA. */}
                  <a
                    href="/admin"
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
