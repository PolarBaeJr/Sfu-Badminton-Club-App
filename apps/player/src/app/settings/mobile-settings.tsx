'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { type useRouter } from 'next/navigation';
import { MATCH_FORMAT_OPTIONS } from '@badminton/shared';
import type { MatchFormat } from '@badminton/shared';
import { SectionLabel } from '@/components/v2/atoms-layout';
import { CTAButton, SettingsGroup, SettingsRow, SettingsToggle } from '@/components/v2/atoms-form';
import { Avatar } from '@/components/v2/atoms-display';

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Match-prefs editable inputs share this base style — same surface, hairline,
// padding, and font as the existing read-only SettingsRow values so the
// transition from "static text" to "editable" is visually consistent.
const textFieldStyle: CSSProperties = {
  width: '100%',
  background: 'var(--surface1)',
  border: '1px solid var(--hairline)',
  color: 'var(--ink)',
  padding: '11px 12px',
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function FieldBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '1.6px',
          textTransform: 'uppercase',
          color: 'var(--text)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const TITLES: Record<string, string> = {
  profile: 'Edit Profile',
  notifications: 'Notifications',
  matches: 'Match Preferences',
  privacy: 'Privacy & Visibility',
  help: 'Help & Feedback',
  signout: 'Sign Out',
  'delete-confirm': 'Delete Account',
};

const DELETE_CONFIRM_PHRASE = 'DELETE';

function SettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <section
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--surface1)',
        borderBottom: '1px solid var(--hairline)',
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
          color: '#F2F2F2',
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

function SkeletonGroup() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
      <div className="skeleton" style={{ height: 60, width: '100%' }} />
    </div>
  );
}

interface MobileSettingsProps {
  view: string;
  router: ReturnType<typeof useRouter>;
  onBack: () => void;

  loaded: boolean;
  name: string;
  displayName: string;
  email: string;
  phone: string;
  bio: string;
  setBio: (v: string) => void;
  avatarUrl: string | null;

  pushSupported: boolean;
  pushEnabled: boolean;
  handlePushToggle: () => Promise<void> | void;

  pushChallenges: boolean;
  setPushChallenges: (v: boolean) => void;
  pushMatches: boolean;
  setPushMatches: (v: boolean) => void;
  pushSessions: boolean;
  setPushSessions: (v: boolean) => void;
  pushWeekly: boolean;
  setPushWeekly: (v: boolean) => void;
  pushAnnounce: boolean;
  setPushAnnounce: (v: boolean) => void;
  emailRecap: boolean;
  setEmailRecap: (v: boolean) => void;
  emailSeason: boolean;
  setEmailSeason: (v: boolean) => void;
  emailMarketing: boolean;
  setEmailMarketing: (v: boolean) => void;

  autoAccept: boolean;
  setAutoAccept: (v: boolean) => void;
  openDoubles: boolean;
  setOpenDoubles: (v: boolean) => void;
  crossSkill: boolean;
  setCrossSkill: (v: boolean) => void;
  matchReminders: boolean;
  setMatchReminders: (v: boolean) => void;

  showOnLeaderboard: boolean;
  setShowOnLeaderboard: (v: boolean) => void;
  showRecord: boolean;
  setShowRecord: (v: boolean) => void;
  showHistory: boolean;
  setShowHistory: (v: boolean) => void;
  discoverable: boolean;
  setDiscoverable: (v: boolean) => void;

  dominantHand: 'left' | 'right' | 'ambidextrous' | '';
  setDominantHand: (v: 'left' | 'right' | 'ambidextrous' | '') => void;
  yearsPlaying: string;
  setYearsPlaying: (v: string) => void;
  favouriteShot: string;
  setFavouriteShot: (v: string) => void;

  // Match preferences (Phase 5 — wired to player_preferences columns)
  availableDays: string[];
  setAvailableDays: (v: string[]) => void;
  availableHoursStart: string;
  setAvailableHoursStart: (v: string) => void;
  availableHoursEnd: string;
  setAvailableHoursEnd: (v: string) => void;
  homeCourt: string;
  setHomeCourt: (v: string) => void;
  defaultScoreFormat: MatchFormat;
  setDefaultScoreFormat: (v: MatchFormat) => void;

  saving: boolean;
  signingOut: boolean;
  deleting: boolean;
  handleSaveProfile: () => void;
  handleSavePrivacy: () => Promise<void>;
  handleSignOut: () => void;
  handleDeleteAccount: () => void;
}

export function MobileSettings(p: MobileSettingsProps) {
  if (p.view === 'index') {
    return (
      <>
        <SettingsHeader title="Settings" onBack={() => p.router.push('/my-stats')} />
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
                onClick={() => p.router.push(`/settings?view=${item.view}`)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: 'var(--dim)', fontSize: 18 }}>›</span>
                </span>
              </SettingsRow>
            ))}
          </SettingsGroup>
        </div>
      </>
    );
  }

  return (
    <>
      <SettingsHeader title={TITLES[p.view] ?? 'Settings'} onBack={p.onBack} />

      {p.view === 'profile' && (
        <div style={{ padding: '20px 24px 24px' }}>
          {!p.loaded ? (
            <SkeletonGroup />
          ) : (
            <>
              <SectionLabel>Identity</SectionLabel>
              <SettingsGroup>
                <SettingsRow label="Display Name" value={p.name || '—'} />
                <SettingsRow label="Handle" value={p.displayName ? `@${p.displayName}` : '—'} />
                <SettingsRow label="Email" value={p.email || '—'} />
                <SettingsRow label="Phone" value={p.phone || '—'} />
              </SettingsGroup>
              <SectionLabel>Photo &amp; bio</SectionLabel>
              <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)', padding: 20, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                  <Avatar name={p.name} src={p.avatarUrl} size={64} ring />
                  <button
                    type="button"
                    title="Photo updates rolling out soon"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--hairline)',
                      color: '#F2F2F2',
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
                  value={p.bio}
                  onChange={(e) => p.setBio(e.target.value)}
                  rows={3}
                  placeholder="Engineering student. Left-handed. Doubles partner welcome."
                  style={{
                    width: '100%',
                    minHeight: 72,
                    background: 'var(--surface2)',
                    border: '1px solid var(--hairline)',
                    color: '#F2F2F2',
                    padding: 10,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <SectionLabel>Playing details</SectionLabel>
              <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)', padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--dim)', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Dominant Hand
                  </label>
                  <select
                    value={p.dominantHand}
                    onChange={(e) => p.setDominantHand(e.target.value as 'left' | 'right' | 'ambidextrous' | '')}
                    style={{
                      width: '100%',
                      background: 'var(--surface2)',
                      border: '1px solid var(--hairline)',
                      color: '#F2F2F2',
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
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--dim)', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Years Playing
                  </label>
                  <select
                    value={p.yearsPlaying}
                    onChange={(e) => p.setYearsPlaying(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'var(--surface2)',
                      border: '1px solid var(--hairline)',
                      color: '#F2F2F2',
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
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--dim)', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                    Favourite Shot
                  </label>
                  <input
                    type="text"
                    value={p.favouriteShot}
                    onChange={(e) => p.setFavouriteShot(e.target.value)}
                    placeholder="e.g. Backhand smash"
                    style={{
                      width: '100%',
                      background: 'var(--surface2)',
                      border: '1px solid var(--hairline)',
                      color: '#F2F2F2',
                      padding: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
              <CTAButton size="lg" full onClick={p.handleSaveProfile} disabled={p.saving}>
                {p.saving ? 'Saving…' : 'Save Profile'}
              </CTAButton>
            </>
          )}
        </div>
      )}

      {p.view === 'notifications' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Push notifications</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="New challenge" hint="When someone challenges you to a match.">
                <SettingsToggle
                  on={p.pushEnabled && p.pushChallenges}
                  onChange={async () => {
                    if (!p.pushEnabled) {
                      await p.handlePushToggle();
                      p.setPushChallenges(true);
                      return;
                    }
                    p.setPushChallenges(!p.pushChallenges);
                  }}
                />
              </SettingsRow>
              <SettingsRow label="Match result" hint="When an opponent confirms a score.">
                <SettingsToggle on={p.pushMatches} onChange={() => p.setPushMatches(!p.pushMatches)} />
              </SettingsRow>
              <SettingsRow label="Session reminders" hint="Two hours before a session you're registered for.">
                <SettingsToggle on={p.pushSessions} onChange={() => p.setPushSessions(!p.pushSessions)} />
              </SettingsRow>
              <SettingsRow label="Weekly recap" hint="Sunday evening summary of your matches.">
                <SettingsToggle on={p.pushWeekly} onChange={() => p.setPushWeekly(!p.pushWeekly)} />
              </SettingsRow>
              <SettingsRow label="League announcements" hint="Pinned posts from club admins.">
                <SettingsToggle on={p.pushAnnounce} onChange={() => p.setPushAnnounce(!p.pushAnnounce)} />
              </SettingsRow>
            </SettingsGroup>
            {!p.pushSupported && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--dim)',
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
                <SettingsToggle on={p.emailRecap} onChange={() => p.setEmailRecap(!p.emailRecap)} />
              </SettingsRow>
              <SettingsRow label="Season updates" hint="Mid-season recaps and end-of-season standings.">
                <SettingsToggle on={p.emailSeason} onChange={() => p.setEmailSeason(!p.emailSeason)} />
              </SettingsRow>
              <SettingsRow label="Tournaments & events" hint="Special events, doubles leagues, social play.">
                <SettingsToggle on={p.emailMarketing} onChange={() => p.setEmailMarketing(!p.emailMarketing)} />
              </SettingsRow>
            </SettingsGroup>
            <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5 }}>
              You'll always receive critical account notices (sign-in alerts, dispute outcomes) regardless of these
              settings.
            </div>
          </div>
        </>
      )}

      {p.view === 'matches' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Availability</SectionLabel>

            {/* Available days — 7 chips, multi-select. Each toggle persists
                immediately via setAvailableDays (chip on/off is a clear
                user intent, no debounce needed). */}
            <FieldBlock label="Available days">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
                {WEEK_DAYS.map((day) => {
                  const active = p.availableDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        p.setAvailableDays(
                          active
                            ? p.availableDays.filter((d) => d !== day)
                            : [...p.availableDays, day]
                        )
                      }
                      style={{
                        padding: '10px 0',
                        background: active ? 'var(--red)' : 'var(--surface1)',
                        color: active ? '#F2F2F2' : 'var(--text)',
                        border: active ? 'none' : '1px solid var(--hairline)',
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </FieldBlock>

            {/* Available hours — two side-by-side time pickers, debounced
                500ms each so we don't spam saves while the picker is open. */}
            <FieldBlock label="Available hours">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                <input
                  type="time"
                  value={p.availableHoursStart}
                  onChange={(e) => p.setAvailableHoursStart(e.target.value)}
                  aria-label="Available hours start"
                  style={textFieldStyle}
                />
                <span style={{ color: 'var(--dim)', fontSize: 13 }}>to</span>
                <input
                  type="time"
                  value={p.availableHoursEnd}
                  onChange={(e) => p.setAvailableHoursEnd(e.target.value)}
                  aria-label="Available hours end"
                  style={textFieldStyle}
                />
              </div>
            </FieldBlock>

            <FieldBlock label="Home court">
              <input
                type="text"
                value={p.homeCourt}
                onChange={(e) => p.setHomeCourt(e.target.value)}
                placeholder="e.g. SFU Burnaby"
                maxLength={80}
                style={textFieldStyle}
              />
            </FieldBlock>
          </div>
          <div style={{ padding: '0 24px 8px' }}>
            <SectionLabel>Challenge preferences</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Auto-accept challenges" hint="Within your skill bracket and available hours.">
                <SettingsToggle on={p.autoAccept} onChange={() => p.setAutoAccept(!p.autoAccept)} />
              </SettingsRow>
              <SettingsRow label="Open to doubles" hint="Show you in the doubles partner pool.">
                <SettingsToggle on={p.openDoubles} onChange={() => p.setOpenDoubles(!p.openDoubles)} />
              </SettingsRow>
              <SettingsRow label="Cross-skill matches" hint="Allow challenges from players >200 ELO away.">
                <SettingsToggle on={p.crossSkill} onChange={() => p.setCrossSkill(!p.crossSkill)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
          <div style={{ padding: '0 24px 24px' }}>
            <SectionLabel>Match logging</SectionLabel>

            {/* Score format — select wired to MATCH_FORMAT_OPTIONS so the
                values match the match_format enum the challenge form uses. */}
            <FieldBlock label="Default score format">
              <select
                value={p.defaultScoreFormat}
                onChange={(e) => p.setDefaultScoreFormat(e.target.value as MatchFormat)}
                style={textFieldStyle}
              >
                {MATCH_FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FieldBlock>

            <SettingsGroup>
              <SettingsRow label="Submission reminders" hint="Nudge me to log scheduled matches.">
                <SettingsToggle on={p.matchReminders} onChange={() => p.setMatchReminders(!p.matchReminders)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
        </>
      )}

      {p.view === 'privacy' && (
        <>
          <div style={{ padding: '20px 24px 8px' }}>
            <SectionLabel>Profile visibility</SectionLabel>
            <SettingsGroup>
              <SettingsRow
                label="Show on leaderboard"
                hint="Your rank and ELO are visible to all players."
              >
                <SettingsToggle
                  on={p.showOnLeaderboard}
                  onChange={() => {
                    p.setShowOnLeaderboard(!p.showOnLeaderboard);
                    void p.handleSavePrivacy();
                  }}
                />
              </SettingsRow>
              <SettingsRow
                label="Show win/loss record"
                hint="Other players can see your detailed record."
              >
                <SettingsToggle on={p.showRecord} onChange={() => p.setShowRecord(!p.showRecord)} />
              </SettingsRow>
              <SettingsRow
                label="Show match history"
                hint="Last 10 matches are visible on your profile."
              >
                <SettingsToggle on={p.showHistory} onChange={() => p.setShowHistory(!p.showHistory)} />
              </SettingsRow>
              <SettingsRow
                label="Discoverable"
                hint="Appear in player search and challenge suggestions."
              >
                <SettingsToggle on={p.discoverable} onChange={() => p.setDiscoverable(!p.discoverable)} />
              </SettingsRow>
            </SettingsGroup>
          </div>
          <div style={{ padding: '0 24px 8px' }}>
            <SectionLabel>Blocked players</SectionLabel>
            <div
              style={{
                background: 'var(--surface1)',
                border: '1px solid var(--hairline)',
                padding: 20,
                marginBottom: 20,
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              You haven&apos;t blocked anyone.
            </div>
          </div>
          <div style={{ padding: '0 24px 24px' }}>
            <SectionLabel>Data</SectionLabel>
            <SettingsGroup>
              <SettingsRow label="Download my data" hint="Export every match, every score, every rating change.">
                <span style={{ color: 'var(--dim)', fontSize: 18 }}>›</span>
              </SettingsRow>
              <SettingsRow
                label="Delete account"
                hint="Removes you from the ladder. Match history is anonymized."
                onClick={() => p.router.push('/settings?view=delete-confirm')}
              >
                <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  Delete
                </span>
              </SettingsRow>
            </SettingsGroup>
          </div>
        </>
      )}

      {p.view === 'help' && (
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
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--hairline)', padding: 20 }}>
            <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '1.4px', textTransform: 'uppercase', color: 'var(--dim)' }}>
              App version
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', marginTop: 6 }}>
              2.4.1 · build 4287
            </div>
            <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 8 }}>
              Tap version number 7 times to enable developer settings.
            </div>
          </div>
        </div>
      )}

      {p.view === 'signout' && (
        <div style={{ padding: '40px 24px 24px', textAlign: 'center' }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto',
              background: 'rgba(var(--red-rgb), 0.10)',
              border: '1px solid rgba(var(--red-rgb), 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              color: 'var(--red)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            ×
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px', marginTop: 18 }}>Sign out?</div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text)',
              marginTop: 10,
              lineHeight: 1.5,
              maxWidth: 280,
              margin: '10px auto 0',
            }}
          >
            You'll need to sign in again to log matches, accept challenges, or check the leaderboard.
          </div>
          <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <CTAButton size="lg" full onClick={p.handleSignOut} disabled={p.signingOut}>
              {p.signingOut ? 'Signing out…' : 'Sign Out'}
            </CTAButton>
            <CTAButton variant="ghost" size="md" full onClick={p.onBack}>
              Cancel
            </CTAButton>
          </div>
        </div>
      )}

      {p.view === 'delete-confirm' && (
        <DeleteAccountConfirm
          deleting={p.deleting}
          onCancel={p.onBack}
          onConfirm={p.handleDeleteAccount}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// DeleteAccountConfirm — full-screen surface in the phone-frame.
// User must type DELETE exactly to enable the destructive button.
// Prevents accidental deletes on rage-tap and on rendered-screenshot
// auto-tap scenarios.
// ─────────────────────────────────────────────────────────────────
function DeleteAccountConfirm({
  deleting,
  onCancel,
  onConfirm,
}: {
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ready = typed === DELETE_CONFIRM_PHRASE && !deleting;

  return (
    <div style={{ padding: '32px 24px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 56,
          height: 56,
          margin: '0 auto',
          background: 'rgba(var(--red-rgb), 0.12)',
          border: '1px solid rgba(var(--red-rgb), 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 30,
          color: 'var(--red)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        !
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px', marginTop: 18 }}>
        Delete account?
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text)',
          marginTop: 10,
          lineHeight: 1.5,
          maxWidth: 300,
          margin: '10px auto 0',
        }}
      >
        This permanently deletes your sign-in, profile photo, bio, and ranking.
        Match history stays intact under the name &ldquo;Deleted Player&rdquo;.{' '}
        <strong style={{ color: 'var(--ink)' }}>This cannot be undone.</strong>
      </div>

      <div style={{ marginTop: 28, textAlign: 'left' }}>
        <label
          htmlFor="delete-confirm-input"
          style={{
            display: 'block',
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            color: 'var(--dim)',
            marginBottom: 6,
          }}
        >
          Type {DELETE_CONFIRM_PHRASE} to confirm
        </label>
        <input
          id="delete-confirm-input"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby="delete-confirm-hint"
          style={{
            width: '100%',
            background: 'var(--surface1)',
            border: '1px solid ' + (ready ? 'var(--red)' : 'var(--hairline)'),
            color: 'var(--ink)',
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.1em',
            padding: '13px 14px',
            boxSizing: 'border-box',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase',
          }}
        />
        <div
          id="delete-confirm-hint"
          style={{
            fontSize: 10,
            color: 'var(--dim)',
            marginTop: 6,
            letterSpacing: '0.04em',
          }}
        >
          Case-sensitive. Must match exactly.
        </div>
      </div>

      <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CTAButton
          size="lg"
          full
          variant="danger"
          disabled={!ready}
          onClick={onConfirm}
        >
          {deleting ? 'Deleting…' : 'Permanently delete account'}
        </CTAButton>
        <CTAButton variant="ghost" size="md" full onClick={onCancel}>
          Cancel
        </CTAButton>
      </div>
    </div>
  );
}
