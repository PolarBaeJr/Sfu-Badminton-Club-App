'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import { updateProfile, updatePreferences } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { MobileSettings } from './mobile-settings';
import { DesktopSettings } from './desktop-settings';

/**
 * Thin shell that owns all state + handlers. Renders both <MobileSettings>
 * (wrapped in m-only) and <DesktopSettings> (wrapped in d-only). CSS in
 * globals.css swaps visibility at the 1024px breakpoint.
 */
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

  return (
    <>
      <div className="m-only">
        <MobileSettings
          view={view}
          router={router}
          onBack={onBack}
          loaded={loaded}
          name={name}
          displayName={displayName}
          email={email}
          phone={phone}
          bio={bio}
          setBio={setBio}
          avatarUrl={avatarUrl}
          pushSupported={pushSupported}
          pushEnabled={pushEnabled}
          handlePushToggle={handlePushToggle}
          pushChallenges={pushChallenges}
          setPushChallenges={setPushChallenges}
          pushMatches={pushMatches}
          setPushMatches={setPushMatches}
          pushSessions={pushSessions}
          setPushSessions={setPushSessions}
          pushWeekly={pushWeekly}
          setPushWeekly={setPushWeekly}
          pushAnnounce={pushAnnounce}
          setPushAnnounce={setPushAnnounce}
          emailRecap={emailRecap}
          setEmailRecap={setEmailRecap}
          emailSeason={emailSeason}
          setEmailSeason={setEmailSeason}
          emailMarketing={emailMarketing}
          setEmailMarketing={setEmailMarketing}
          autoAccept={autoAccept}
          setAutoAccept={setAutoAccept}
          openDoubles={openDoubles}
          setOpenDoubles={setOpenDoubles}
          crossSkill={crossSkill}
          setCrossSkill={setCrossSkill}
          matchReminders={matchReminders}
          setMatchReminders={setMatchReminders}
          showOnLeaderboard={showOnLeaderboard}
          setShowOnLeaderboard={setShowOnLeaderboard}
          showRecord={showRecord}
          setShowRecord={setShowRecord}
          showHistory={showHistory}
          setShowHistory={setShowHistory}
          discoverable={discoverable}
          setDiscoverable={setDiscoverable}
          dominantHand={dominantHand}
          setDominantHand={setDominantHand}
          yearsPlaying={yearsPlaying}
          setYearsPlaying={setYearsPlaying}
          favouriteShot={favouriteShot}
          setFavouriteShot={setFavouriteShot}
          saving={saving}
          signingOut={signingOut}
          handleSaveProfile={handleSaveProfile}
          handleSavePrivacy={handleSavePrivacy}
          handleSignOut={handleSignOut}
        />
      </div>
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
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
      <SettingsContent />
    </Suspense>
  );
}
