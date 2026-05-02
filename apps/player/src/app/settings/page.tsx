'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import { updateProfile, updatePreferences } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import {
  Avatar,
  CTAButton,
  SectionLabel,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from '@/components/v2/atoms';
import { DesktopSettings } from './desktop-settings';

const TITLES: Record<string, string> = {
  profile: 'Edit Profile',
  notifications: 'Notifications',
  matches: 'Match Preferences',
  privacy: 'Privacy & Visibility',
  help: 'Help & Feedback',
  signout: 'Sign Out',
};

function SettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <section
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: '#181818',
        borderBottom: '1px solid #303030',
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <button
        type="button"
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#fff',
          fontSize: 26,
          lineHeight: 1,
          cursor: 'pointer',
          padding: '0 8px',
          fontFamily: 'inherit',
        }}
        aria-label="Back"
      >
        ‹
      </button>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{title}</div>
    </section>
  );
}

function SettingsContent() {
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get('view') ?? 'index';
  const { toast } = useToast();

  const [loaded, setLoaded] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showOnLeaderboard, setShowOnLeaderboard] = useState(true);
  const [showActivity, setShowActivity] = useState(true);

  // Push
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);

  // Local-only toggles for UX surfaces (not yet backed by API — match v2 design surface)
  const [pushChallenges, setPushChallenges] = useState(true);
  const [pushMatches, setPushMatches] = useState(true);
  const [pushSessions, setPushSessions] = useState(false);
  const [pushWeekly, setPushWeekly] = useState(true);
  const [pushAnnounce, setPushAnnounce] = useState(true);
  const [emailRecap, setEmailRecap] = useState(true);
  const [emailSeason, setEmailSeason] = useState(true);
  const [emailMarketing, setEmailMarketing] = useState(false);

  const [autoAccept, setAutoAccept] = useState(false);
  const [openDoubles, setOpenDoubles] = useState(true);
  const [crossSkill, setCrossSkill] = useState(true);
  const [matchReminders, setMatchReminders] = useState(true);

  const [showRecord, setShowRecord] = useState(true);
  const [showHistory, setShowHistory] = useState(true);
  const [discoverable, setDiscoverable] = useState(true);

  // Playing details (newly schema-backed)
  const [dominantHand, setDominantHand] = useState<'left' | 'right' | 'ambidextrous' | ''>('');
  const [yearsPlaying, setYearsPlaying] = useState('');
  const [favouriteShot, setFavouriteShot] = useState('');

  // Desktop-only preferences (persisted into players.notification_preferences JSONB)
  const [defaultFormat, setDefaultFormat] = useState<'singles' | 'doubles'>('singles');
  const [leaderboardDefault, setLeaderboardDefault] = useState<'singles' | 'doubles'>('singles');
  const [preferredDays, setPreferredDays] = useState<string[]>(['Fri', 'Sat']);
  const [emailChannel, setEmailChannel] = useState(true);

  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from('players')
        .select('*')
        .eq('user_id', user.id)
        .single();
      if (!data || cancelled) return;

      setPlayerId(data.id);
      setName(data.full_name ?? '');
      setDisplayName(data.display_name ?? '');
      setBio(data.bio ?? '');
      setPhone(data.phone ?? '');
      setEmail((data.email as string | null) ?? user.email ?? '');
      setAvatarUrl(data.avatar_url ?? null);
      setShowOnLeaderboard(!data.hide_from_leaderboard);
      setShowActivity(data.show_activity_status !== false);
      setDominantHand((data.dominant_hand as 'left' | 'right' | 'ambidextrous' | null) ?? '');
      setYearsPlaying((data.years_playing as string | null) ?? '');
      setFavouriteShot((data.favourite_shot as string | null) ?? '');

      // Hydrate desktop-only prefs from notification_preferences JSONB
      const prefs = (data.notification_preferences as Record<string, unknown> | null) ?? {};
      if (prefs.defaultFormat === 'singles' || prefs.defaultFormat === 'doubles') {
        setDefaultFormat(prefs.defaultFormat);
      }
      if (prefs.leaderboardDefault === 'singles' || prefs.leaderboardDefault === 'doubles') {
        setLeaderboardDefault(prefs.leaderboardDefault);
      }
      if (Array.isArray(prefs.preferredDays)) {
        setPreferredDays(prefs.preferredDays.filter((d): d is string => typeof d === 'string'));
      }
      if (typeof prefs.emailChannel === 'boolean') {
        setEmailChannel(prefs.emailChannel);
      }

      setLoaded(true);

      setPushSupported(isPushSupported());
      isPushEnabled().then(setPushEnabled);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSaveProfile() {
    setSaving(true);
    try {
      await updateProfile({
        full_name: name,
        display_name: displayName || undefined,
        phone: phone || undefined,
        bio: bio || undefined,
        dominant_hand: dominantHand === '' ? null : dominantHand,
        years_playing: yearsPlaying || null,
        favourite_shot: favouriteShot || null,
      });
      toast('Profile updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSaving(false);
  }

  async function handleSavePrivacy() {
    setSaving(true);
    try {
      await updateProfile({
        full_name: name,
        hide_from_leaderboard: !showOnLeaderboard,
        show_activity_status: showActivity,
      });
      toast('Privacy updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSaving(false);
  }

  async function handlePushToggle() {
    if (!pushSupported || !playerId) return;
    try {
      if (pushEnabled) {
        await unsubscribeFromPush(playerId);
        setPushEnabled(false);
      } else {
        const ok = await subscribeToPush(playerId);
        if (ok) setPushEnabled(true);
      }
    } catch {
      toast('Failed to update push', 'error');
    }
  }

  async function handleSavePreferences() {
    setSaving(true);
    try {
      await updatePreferences({
        defaultFormat,
        leaderboardDefault,
        preferredDays,
        emailChannel,
        // Notification toggles also live here so they persist across sessions
        pushChallenges,
        pushMatches,
        pushSessions,
        pushAnnounce,
        pushWeekly,
        emailRecap,
        emailSeason,
        emailMarketing,
        autoAccept,
        openDoubles,
        crossSkill,
        matchReminders,
      });
      toast('Preferences saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSaving(false);
  }

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  const onBack = () => router.push('/my-stats');

  const desktopBlock = (
    <div className="d-only">
      <DesktopSettings
        loaded={loaded}
        name={name}
        setName={setName}
        displayName={displayName}
        setDisplayName={setDisplayName}
        email={email}
        showOnLeaderboard={showOnLeaderboard}
        setShowOnLeaderboard={setShowOnLeaderboard}
        showRecord={showRecord}
        setShowRecord={setShowRecord}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        discoverable={discoverable}
        setDiscoverable={setDiscoverable}
        pushChallenges={pushChallenges}
        setPushChallenges={setPushChallenges}
        pushMatches={pushMatches}
        setPushMatches={setPushMatches}
        pushSessions={pushSessions}
        setPushSessions={setPushSessions}
        pushAnnounce={pushAnnounce}
        setPushAnnounce={setPushAnnounce}
        emailRecap={emailRecap}
        setEmailRecap={setEmailRecap}
        pushSupported={pushSupported}
        pushEnabled={pushEnabled}
        handlePushToggle={handlePushToggle}
        autoAccept={autoAccept}
        setAutoAccept={setAutoAccept}
        openDoubles={openDoubles}
        setOpenDoubles={setOpenDoubles}
        crossSkill={crossSkill}
        setCrossSkill={setCrossSkill}
        defaultFormat={defaultFormat}
        setDefaultFormat={setDefaultFormat}
        leaderboardDefault={leaderboardDefault}
        setLeaderboardDefault={setLeaderboardDefault}
        preferredDays={preferredDays}
        setPreferredDays={setPreferredDays}
        emailChannel={emailChannel}
        setEmailChannel={setEmailChannel}
        saving={saving}
        signingOut={signingOut}
        handleSaveProfile={handleSaveProfile}
        handleSavePrivacy={handleSavePrivacy}
        handleSavePreferences={handleSavePreferences}
        handleSignOut={handleSignOut}
      />
    </div>
  );

  if (view === 'index') {
    return (
      <>
        <div className="m-only">
          <SettingsHeader title="Settings" onBack={() => router.push('/my-stats')} />
          <div style={{ padding: '20px 24px 24px' }}>
            <SectionLabel>Account</SectionLabel>
            <SettingsGroup>
              {[
                { label: 'Edit Profile', view: 'profile' },
                { label: 'Notifications', view: 'notifications' },
                { label: 'Match Preferences', view: 'matches' },
                { label: 'Privacy & Visibility', view: 'privacy' },
                { label: 'Help & Feedback', view: 'help' },
                { label: 'Sign Out', view: 'signout', danger: true },
              ].map((item) => (
                <SettingsRow
                  key={item.label}
                  label={item.label}
                  onClick={() => router.push(`/settings?view=${item.view}`)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#666', fontSize: 18 }}>›</span>
                  </span>
                </SettingsRow>
              ))}
            </SettingsGroup>
          </div>
        </div>
        {desktopBlock}
      </>
    );
  }

  return (
    <>
      <div className="m-only">
      <SettingsHeader title={TITLES[view] ?? 'Settings'} onBack={onBack} />

      {view === 'profile' && (
        <div style={{ padding: '20px 24px 24px' }}>
          {!loaded ? (
            <SkeletonGroup />
          ) : (
            <>
              <SectionLabel>Identity</SectionLabel>
              <SettingsGroup>
                <SettingsRow label="Display Name" value={name || '—'} />
                <SettingsRow label="Handle" value={displayName ? `@${displayName}` : '—'} />
                <SettingsRow label="Email" value={email || '—'} />
                <SettingsRow label="Phone" value={phone || '—'} />
              </SettingsGroup>
              <SectionLabel>Photo &amp; bio</SectionLabel>
              <div style={{ background: '#222', border: '1px solid #303030', padding: 20, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                  <Avatar name={name} src={avatarUrl} size={64} ring />
                  <button
                    type="button"
                    title="Photo updates rolling out soon"
                    style={{
                      background: 'transparent',
                      border: '1px solid #303030',
                      color: '#fff',
                      padding: '8px 14px',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '1px',
                      textTransform: 'uppercase',
                      cursor: 'not-allowed',
                      fontFamily: 'inherit',
                      opacity: 0.7,
                    }}
                  >
                    Change photo
                  </button>
                </div>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  placeholder="Engineering student. Left-handed. Doubles partner welcome."
                  style={{
                    width: '100%',
                    minHeight: 72,
                    background: '#1a1a1a',
                    border: '1px solid #303030',
                    color: '#fff',
                    padding: 10,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <SectionLabel>Playing details</SectionLabel>
              <div style={{ background: '#222', border: '1px solid #303030', padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: '#666', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Dominant Hand
                  </label>
                  <select
                    value={dominantHand}
                    onChange={(e) => setDominantHand(e.target.value as 'left' | 'right' | 'ambidextrous' | '')}
                    style={{
                      width: '100%',
                      background: '#1a1a1a',
                      border: '1px solid #303030',
                      color: '#fff',
                      padding: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  >
                    <option value="">— select —</option>
                    <option value="right">Right</option>
                    <option value="left">Left</option>
                    <option value="ambidextrous">Ambidextrous</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: '#666', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Years Playing
                  </label>
                  <select
                    value={yearsPlaying}
                    onChange={(e) => setYearsPlaying(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#1a1a1a',
                      border: '1px solid #303030',
                      color: '#fff',
                      padding: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  >
                    <option value="">— select —</option>
                    <option value="<1">Less than 1 year</option>
                    <option value="1-3">1–3 years</option>
                    <option value="3-5">3–5 years</option>
                    <option value="5+">5+ years</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: '#666', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Favourite Shot
                  </label>
                  <input
                    type="text"
                    value={favouriteShot}
                    onChange={(e) => setFavouriteShot(e.target.value)}
                    placeholder="e.g. Backhand smash"
                    style={{
                      width: '100%',
                      background: '#1a1a1a',
                      border: '1px solid #303030',
                      color: '#fff',
                      padding: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
              <CTAButton size="lg" full onClick={handleSaveProfile} disabled={saving}>
                {saving ? 'Saving…' : 'Save Profile'}
              </CTAButton>
            </>
          )}
        </div>
      )}

      {view === 'notifications' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Push notifications</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="New challenge" hint="When someone challenges you to a match.">
                <SettingsToggle
                  on={pushEnabled && pushChallenges}
                  onChange={async () => {
                    if (!pushEnabled) {
                      await handlePushToggle();
                      setPushChallenges(true);
                      return;
                    }
                    setPushChallenges(!pushChallenges);
                  }}
                />
              </SettingsRow>
              <SettingsRow label="Match result" hint="When an opponent confirms a score.">
                <SettingsToggle on={pushMatches} onChange={() => setPushMatches(!pushMatches)} />
              </SettingsRow>
              <SettingsRow label="Session reminders" hint="Two hours before a session you're registered for.">
                <SettingsToggle on={pushSessions} onChange={() => setPushSessions(!pushSessions)} />
              </SettingsRow>
              <SettingsRow label="Weekly recap" hint="Sunday evening summary of your matches.">
                <SettingsToggle on={pushWeekly} onChange={() => setPushWeekly(!pushWeekly)} />
              </SettingsRow>
              <SettingsRow label="League announcements" hint="Pinned posts from club admins.">
                <SettingsToggle on={pushAnnounce} onChange={() => setPushAnnounce(!pushAnnounce)} />
              </SettingsRow>
            </SettingsGroup>
            {!pushSupported && (
              <div
                style={{
                  fontSize: 11,
                  color: '#666',
                  lineHeight: 1.5,
                  marginBottom: 20,
                }}
              >
                Push not supported in this browser. Notifications still arrive over email.
              </div>
            )}
          </div>
          <div style={{ padding: '0 24px 24px' }}>
            <SectionLabel>Email</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Weekly recap" hint="Top movers, biggest upsets, your week's results.">
                <SettingsToggle on={emailRecap} onChange={() => setEmailRecap(!emailRecap)} />
              </SettingsRow>
              <SettingsRow label="Season updates" hint="Mid-season recaps and end-of-season standings.">
                <SettingsToggle on={emailSeason} onChange={() => setEmailSeason(!emailSeason)} />
              </SettingsRow>
              <SettingsRow label="Tournaments & events" hint="Special events, doubles leagues, social play.">
                <SettingsToggle on={emailMarketing} onChange={() => setEmailMarketing(!emailMarketing)} />
              </SettingsRow>
            </SettingsGroup>
            <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
              You'll always receive critical account notices (sign-in alerts, dispute outcomes) regardless of these
              settings.
            </div>
          </div>
        </>
      )}

      {view === 'matches' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Availability</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Available days" value="Mon – Fri" />
              <SettingsRow label="Available hours" value="5 PM – 10 PM" />
              <SettingsRow label="Home court" value="SFU Burnaby" />
            </SettingsGroup>
          </div>
          <div style={{ padding: '0 24px 8px' }}>
            <SectionLabel>Challenge preferences</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Auto-accept challenges" hint="Within your skill bracket and available hours.">
                <SettingsToggle on={autoAccept} onChange={() => setAutoAccept(!autoAccept)} />
              </SettingsRow>
              <SettingsRow label="Open to doubles" hint="Show you in the doubles partner pool.">
                <SettingsToggle on={openDoubles} onChange={() => setOpenDoubles(!openDoubles)} />
              </SettingsRow>
              <SettingsRow label="Cross-skill matches" hint="Allow challenges from players >200 ELO away.">
                <SettingsToggle on={crossSkill} onChange={() => setCrossSkill(!crossSkill)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
          <div style={{ padding: '0 24px 24px' }}>
            <SectionLabel>Match logging</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Default match type" value="Singles" />
              <SettingsRow label="Score format" value="Best of 3 to 21" />
              <SettingsRow label="Submission reminders" hint="Nudge me to log scheduled matches.">
                <SettingsToggle on={matchReminders} onChange={() => setMatchReminders(!matchReminders)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
        </>
      )}

      {view === 'privacy' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Profile visibility</SectionLabel>
            <SettingsGroup>
              <SettingsRow
                label="Show on leaderboard"
                hint="Your rank and ELO are visible to all players."
              >
                <SettingsToggle
                  on={showOnLeaderboard}
                  onChange={() => {
                    setShowOnLeaderboard(!showOnLeaderboard);
                    void handleSavePrivacy();
                  }}
                />
              </SettingsRow>
              <SettingsRow
                label="Show win/loss record"
                hint="Other players can see your detailed record."
              >
                <SettingsToggle on={showRecord} onChange={() => setShowRecord(!showRecord)} />
              </SettingsRow>
              <SettingsRow
                label="Show match history"
                hint="Last 10 matches are visible on your profile."
              >
                <SettingsToggle on={showHistory} onChange={() => setShowHistory(!showHistory)} />
              </SettingsRow>
              <SettingsRow
                label="Discoverable"
                hint="Appear in player search and challenge suggestions."
              >
                <SettingsToggle on={discoverable} onChange={() => setDiscoverable(!discoverable)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
          <div style={{ padding: '0 24px 8px' }}>
            <SectionLabel>Blocked players</SectionLabel>
            <div
              style={{
                background: '#222',
                border: '1px solid #303030',
                padding: 20,
                marginBottom: 20,
                textAlign: 'center',
                fontSize: 12,
                color: '#969696',
              }}
            >
              You haven&apos;t blocked anyone.
            </div>
          </div>
          <div style={{ padding: '0 24px 24px' }}>
            <SectionLabel>Data</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Download my data" hint="Export every match, every score, every rating change.">
                <span style={{ color: '#666', fontSize: 18 }}>›</span>
              </SettingsRow>
              <SettingsRow label="Delete account" hint="Removes you from the ladder. Match history is anonymized.">
                <span style={{ color: '#da291c', fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  Delete
                </span>
              </SettingsRow>
            </SettingsGroup>
          </div>
        </>
      )}

      {view === 'help' && (
        <div style={{ padding: '20px 24px 24px' }}>
          <SectionLabel>Get help</SectionLabel>
          <SettingsGroup>
            <SettingsRow label="How ELO works" />
            <SettingsRow label="Match dispute process" />
            <SettingsRow label="Court etiquette" />
            <SettingsRow label="FAQ" />
          </SettingsGroup>
          <SectionLabel>Contact</SectionLabel>
          <SettingsGroup>
            <SettingsRow label="Message a club admin" hint="Average response time: 4 hours." />
            <SettingsRow label="Report a bug" />
            <SettingsRow label="Suggest a feature" />
          </SettingsGroup>
          <div style={{ background: '#1a1a1a', border: '1px solid #303030', padding: 20 }}>
            <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '1.4px', textTransform: 'uppercase', color: '#666' }}>
              App version
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', marginTop: 6 }}>
              2.4.1 · build 4287
            </div>
            <div style={{ fontSize: 11, color: '#969696', marginTop: 8 }}>
              Tap version number 7 times to enable developer settings.
            </div>
          </div>
        </div>
      )}

      {view === 'signout' && (
        <div style={{ padding: '40px 24px 24px', textAlign: 'center' }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto',
              background: 'rgba(218,41,28,0.10)',
              border: '1px solid rgba(218,41,28,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              color: '#da291c',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            ×
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px', marginTop: 18 }}>Sign out?</div>
          <div
            style={{
              fontSize: 13,
              color: '#969696',
              marginTop: 10,
              lineHeight: 1.5,
              maxWidth: 280,
              margin: '10px auto 0',
            }}
          >
            You'll need to sign in again to log matches, accept challenges, or check the leaderboard.
          </div>
          <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <CTAButton size="lg" full onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign Out'}
            </CTAButton>
            <CTAButton variant="ghost" size="md" full onClick={onBack}>
              Cancel
            </CTAButton>
          </div>
        </div>
      )}
      </div>{/* /.m-only */}
      {desktopBlock}
    </>
  );
}

function SkeletonGroup() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
      <SettingsContent />
    </Suspense>
  );
}
