'use client';

import { useCallback, useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import {
  updateProfile,
  updatePreferences,
  getPlayerPreferences,
  updatePlayerPreferences,
  deleteAccount,
} from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { MobileSettings } from './mobile-settings';
import { DesktopSettings } from './desktop-settings';
import type { Database } from '@badminton/shared/database';

type PlayerPreferencesRow = Database['public']['Tables']['player_preferences']['Row'];
type PlayerPreferencesUpdate = Database['public']['Tables']['player_preferences']['Update'];

// TODO: Phase 10 — when the platform supports multiple clubs, scope the
// preferences fetch by (player_id, organization_id).

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
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Player profile (legacy columns) and player_preferences (new normalized
      // table from Phase 2) fetched in parallel.
      const [{ data }, prefsResult] = await Promise.all([
        supabase.from('players').select('*').eq('user_id', user.id).single(),
        getPlayerPreferences().then(
          (p) => ({ ok: true as const, p }),
          (e) => ({ ok: false as const, e: e as Error })
        ),
      ]);
      if (!data || cancelled) return;

      setPlayerId(data.id);
      setName(data.full_name ?? '');
      setDisplayName(data.display_name ?? '');
      setBio(data.bio ?? '');
      setPhone(data.phone ?? '');
      setEmail((data.email as string | null) ?? user.email ?? '');
      setAvatarUrl(data.avatar_url ?? null);
      // showActivity stays on the legacy players column — no matching
      // column in player_preferences (flagged in Phase 4 report).
      setShowActivity(data.show_activity_status !== false);
      setDominantHand((data.dominant_hand as 'left' | 'right' | 'ambidextrous' | null) ?? '');
      setYearsPlaying((data.years_playing as string | null) ?? '');
      setFavouriteShot((data.favourite_shot as string | null) ?? '');

      // ── Hydrate from player_preferences (source of truth) ───────────
      // If the fetch failed, fall back to legacy players columns + JSONB so
      // the settings surface still loads.
      if (prefsResult.ok) {
        const pp = prefsResult.p;
        // Notifications (push)
        setPushChallenges(pp.notify_new_challenge);
        setPushMatches(pp.notify_match_result);
        setPushSessions(pp.notify_session_reminder);
        setPushWeekly(pp.notify_weekly_recap_push);
        setPushAnnounce(pp.notify_league_announcements);
        // Notifications (email)
        setEmailRecap(pp.notify_weekly_recap_email);
        setEmailSeason(pp.notify_season_updates);
        setEmailMarketing(pp.notify_tournaments_events);
        // Match prefs
        setAutoAccept(pp.auto_accept_challenges);
        setOpenDoubles(pp.open_to_doubles);
        setCrossSkill(pp.cross_skill_matches);
        setMatchReminders(pp.submission_reminders);
        // Privacy
        setShowOnLeaderboard(pp.show_on_leaderboard);
        setShowRecord(pp.show_win_loss_record);
        setShowHistory(pp.show_match_history);
        setDiscoverable(pp.discoverable);
        // Match logging — a player-preference column maps directly to the
        // desktop "Default Format" segmented control too.
        if (pp.default_match_type === 'singles' || pp.default_match_type === 'doubles') {
          setDefaultFormat(pp.default_match_type);
        }
        // available_days seeds the desktop preferredDays multi-select
        if (Array.isArray(pp.available_days)) {
          setPreferredDays(pp.available_days);
        }
      } else {
        // Legacy fallback path — should rarely fire (Phase 2 backfill seeds
        // the row for every player) but keeps the surface usable on outage.
        setShowOnLeaderboard(!data.hide_from_leaderboard);
      }

      // ── Hydrate desktop-only orphans from legacy JSONB ──────────────
      // leaderboardDefault and emailChannel have no matching player_preferences
      // column. Phase 4 leaves them on legacy storage; flagged in report.
      const prefs = (data.notification_preferences as Record<string, unknown> | null) ?? {};
      if (prefs.leaderboardDefault === 'singles' || prefs.leaderboardDefault === 'doubles') {
        setLeaderboardDefault(prefs.leaderboardDefault);
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

  // ── Optimistic toggle helper ──────────────────────────────────────
  // Wrap a (boolean setter, current value, column) into a function with the
  // same `(next: boolean) => void` signature MobileSettings/DesktopSettings
  // already expect. Updates local state immediately, fires the action in the
  // background, reverts + toasts on error. The captured `current` is the
  // value at render time, which is exactly the value just before the toggle.
  const persistedToggle = useCallback(
    <K extends keyof PlayerPreferencesUpdate>(
      column: K,
      current: boolean,
      setter: (v: boolean) => void
    ) =>
      (next: boolean) => {
        setter(next);
        void updatePlayerPreferences({ [column]: next } as PlayerPreferencesUpdate).catch(
          (err: unknown) => {
            setter(current);
            toast(err instanceof Error ? err.message : "Couldn't save", 'error');
          }
        );
      },
    [toast]
  );

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
    // Drop any cached client state that survives sign-out: the QR redirect
    // hint stored on /login by the auth flow, and any router cache holding
    // an authed payload that the layout would otherwise re-use.
    try {
      sessionStorage.removeItem('qr_redirect');
    } catch {
      /* sessionStorage may be unavailable in some embedded contexts */
    }
    router.push('/login');
    router.refresh();
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      await deleteAccount();
      // Account anonymized + auth.users row deleted server-side. Sign out
      // locally to drop the client session/cookies and bounce to /login.
      const supabase = createClient();
      await supabase.auth.signOut();
      try {
        sessionStorage.removeItem('qr_redirect');
      } catch {
        /* no-op */
      }
      router.push('/login');
      router.refresh();
    } catch (err) {
      setDeleting(false);
      toast(err instanceof Error ? err.message : 'Could not delete account', 'error');
    }
  }

  const onBack = () => router.push('/my-stats');

  // Persistence wrappers — same `(v: boolean) => void` signature as the
  // raw setters, but each toggle now writes to player_preferences with
  // optimistic UX + revert-on-error. The captured `current` value is
  // the value at this render, which is exactly the value just before
  // the toggle fires.
  const setPushChallengesP   = persistedToggle('notify_new_challenge',         pushChallenges, setPushChallenges);
  const setPushMatchesP      = persistedToggle('notify_match_result',          pushMatches,    setPushMatches);
  const setPushSessionsP     = persistedToggle('notify_session_reminder',      pushSessions,   setPushSessions);
  const setPushWeeklyP       = persistedToggle('notify_weekly_recap_push',     pushWeekly,     setPushWeekly);
  const setPushAnnounceP     = persistedToggle('notify_league_announcements',  pushAnnounce,   setPushAnnounce);
  const setEmailRecapP       = persistedToggle('notify_weekly_recap_email',    emailRecap,     setEmailRecap);
  const setEmailSeasonP      = persistedToggle('notify_season_updates',        emailSeason,    setEmailSeason);
  const setEmailMarketingP   = persistedToggle('notify_tournaments_events',    emailMarketing, setEmailMarketing);
  const setAutoAcceptP       = persistedToggle('auto_accept_challenges',       autoAccept,     setAutoAccept);
  const setOpenDoublesP      = persistedToggle('open_to_doubles',              openDoubles,    setOpenDoubles);
  const setCrossSkillP       = persistedToggle('cross_skill_matches',          crossSkill,     setCrossSkill);
  const setMatchRemindersP   = persistedToggle('submission_reminders',         matchReminders, setMatchReminders);
  const setShowOnLeaderboardP = persistedToggle('show_on_leaderboard',         showOnLeaderboard, setShowOnLeaderboard);
  const setShowRecordP       = persistedToggle('show_win_loss_record',         showRecord,     setShowRecord);
  const setShowHistoryP      = persistedToggle('show_match_history',           showHistory,    setShowHistory);
  const setDiscoverableP     = persistedToggle('discoverable',                 discoverable,   setDiscoverable);

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
          setPushChallenges={setPushChallengesP}
          pushMatches={pushMatches}
          setPushMatches={setPushMatchesP}
          pushSessions={pushSessions}
          setPushSessions={setPushSessionsP}
          pushWeekly={pushWeekly}
          setPushWeekly={setPushWeeklyP}
          pushAnnounce={pushAnnounce}
          setPushAnnounce={setPushAnnounceP}
          emailRecap={emailRecap}
          setEmailRecap={setEmailRecapP}
          emailSeason={emailSeason}
          setEmailSeason={setEmailSeasonP}
          emailMarketing={emailMarketing}
          setEmailMarketing={setEmailMarketingP}
          autoAccept={autoAccept}
          setAutoAccept={setAutoAcceptP}
          openDoubles={openDoubles}
          setOpenDoubles={setOpenDoublesP}
          crossSkill={crossSkill}
          setCrossSkill={setCrossSkillP}
          matchReminders={matchReminders}
          setMatchReminders={setMatchRemindersP}
          showOnLeaderboard={showOnLeaderboard}
          setShowOnLeaderboard={setShowOnLeaderboardP}
          showRecord={showRecord}
          setShowRecord={setShowRecordP}
          showHistory={showHistory}
          setShowHistory={setShowHistoryP}
          discoverable={discoverable}
          setDiscoverable={setDiscoverableP}
          dominantHand={dominantHand}
          setDominantHand={setDominantHand}
          yearsPlaying={yearsPlaying}
          setYearsPlaying={setYearsPlaying}
          favouriteShot={favouriteShot}
          setFavouriteShot={setFavouriteShot}
          saving={saving}
          signingOut={signingOut}
          deleting={deleting}
          handleSaveProfile={handleSaveProfile}
          handleSavePrivacy={handleSavePrivacy}
          handleSignOut={handleSignOut}
          handleDeleteAccount={handleDeleteAccount}
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
          setShowOnLeaderboard={setShowOnLeaderboardP}
          showRecord={showRecord}
          setShowRecord={setShowRecordP}
          showHistory={showHistory}
          setShowHistory={setShowHistoryP}
          discoverable={discoverable}
          setDiscoverable={setDiscoverableP}
          pushChallenges={pushChallenges}
          setPushChallenges={setPushChallengesP}
          pushMatches={pushMatches}
          setPushMatches={setPushMatchesP}
          pushSessions={pushSessions}
          setPushSessions={setPushSessionsP}
          pushAnnounce={pushAnnounce}
          setPushAnnounce={setPushAnnounceP}
          emailRecap={emailRecap}
          setEmailRecap={setEmailRecapP}
          pushSupported={pushSupported}
          pushEnabled={pushEnabled}
          handlePushToggle={handlePushToggle}
          autoAccept={autoAccept}
          setAutoAccept={setAutoAcceptP}
          openDoubles={openDoubles}
          setOpenDoubles={setOpenDoublesP}
          crossSkill={crossSkill}
          setCrossSkill={setCrossSkillP}
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
          deleting={deleting}
          handleSaveProfile={handleSaveProfile}
          handleSavePrivacy={handleSavePrivacy}
          handleSavePreferences={handleSavePreferences}
          handleSignOut={handleSignOut}
          handleDeleteAccount={handleDeleteAccount}
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
