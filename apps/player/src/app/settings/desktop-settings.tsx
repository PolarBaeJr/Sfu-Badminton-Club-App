'use client';

import { DPageHead } from '@/components/desktop/page-shell';
import { useState } from 'react';

type Tab = 'profile' | 'preferences' | 'notifications' | 'challenges' | 'account';

interface DesktopSettingsProps {
  loaded: boolean;
  name: string;
  setName: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  email: string;
  showOnLeaderboard: boolean;
  setShowOnLeaderboard: (v: boolean) => void;
  showRecord: boolean;
  setShowRecord: (v: boolean) => void;
  showHistory: boolean;
  setShowHistory: (v: boolean) => void;
  discoverable: boolean;
  setDiscoverable: (v: boolean) => void;
  pushChallenges: boolean;
  setPushChallenges: (v: boolean) => void;
  pushMatches: boolean;
  setPushMatches: (v: boolean) => void;
  pushSessions: boolean;
  setPushSessions: (v: boolean) => void;
  pushAnnounce: boolean;
  setPushAnnounce: (v: boolean) => void;
  emailRecap: boolean;
  setEmailRecap: (v: boolean) => void;
  pushSupported: boolean;
  pushEnabled: boolean;
  handlePushToggle: () => void;
  autoAccept: boolean;
  setAutoAccept: (v: boolean) => void;
  openDoubles: boolean;
  setOpenDoubles: (v: boolean) => void;
  crossSkill: boolean;
  setCrossSkill: (v: boolean) => void;
  // Lifted preferences (persisted into notification_preferences JSONB)
  defaultFormat: 'singles' | 'doubles';
  setDefaultFormat: (v: 'singles' | 'doubles') => void;
  leaderboardDefault: 'singles' | 'doubles';
  setLeaderboardDefault: (v: 'singles' | 'doubles') => void;
  preferredDays: string[];
  setPreferredDays: (v: string[]) => void;
  emailChannel: boolean;
  setEmailChannel: (v: boolean) => void;
  saving: boolean;
  signingOut: boolean;
  handleSaveProfile: () => void;
  handleSavePrivacy: () => void;
  handleSavePreferences: () => void;
  handleSignOut: () => void;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function DesktopSettings(p: DesktopSettingsProps) {
  const [tab, setTab] = useState<Tab>('profile');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'challenges', label: 'Challenges' },
    { id: 'account', label: 'Account' },
  ];

  return (
    <>
      <DPageHead
        eyebrow="Configuration"
        title="Settings."
        meta="Your profile, preferences, and how you receive notifications."
      />
      <div className="d-settings-layout">
        <div className="d-settings-tabs">
          {tabs.map((t) => (
            <a
              key={t.id}
              className={`d-settings-tab${tab === t.id ? ' d-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </a>
          ))}
        </div>

        <div>
          {/* PROFILE */}
          <div className={`d-settings-panel${tab === 'profile' ? ' d-active' : ''}`}>
            <h3>Profile</h3>
            <p className="d-lede">
              Your name and how the club sees you. Email is verified once and read-only.
            </p>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Display Name</div>
                <div className="d-hint">Visible on the leaderboard and in challenges.</div>
              </div>
              <div>
                <input
                  className="d-field"
                  value={p.name}
                  onChange={(e) => p.setName(e.target.value)}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Handle</div>
                <div className="d-hint">Optional shorter username for mentions.</div>
              </div>
              <div>
                <input
                  className="d-field"
                  value={p.displayName}
                  onChange={(e) => p.setDisplayName(e.target.value)}
                  placeholder="e.g. apark"
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">SFU Email</div>
                <div className="d-hint">Verified at sign-up. Contact an admin to change.</div>
              </div>
              <div>
                <input className="d-field" value={p.email} disabled style={{ opacity: 0.6 }} />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Show My ELO</div>
                <div className="d-hint">Display your current rating on your public card.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.showRecord ? ' d-on' : ''}`}
                  onClick={() => p.setShowRecord(!p.showRecord)}
                  role="switch"
                  aria-checked={p.showRecord}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Show Match History Publicly</div>
                <div className="d-hint">Other club members can browse your past matches.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.showHistory ? ' d-on' : ''}`}
                  onClick={() => p.setShowHistory(!p.showHistory)}
                  role="switch"
                  aria-checked={p.showHistory}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Allow Challenges from Anyone</div>
                <div className="d-hint">Off limits challenges to players within 200 ELO.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.discoverable ? ' d-on' : ''}`}
                  onClick={() => p.setDiscoverable(!p.discoverable)}
                  role="switch"
                  aria-checked={p.discoverable}
                />
              </div>
            </div>
            <div className="d-save-row">
              <button
                type="button"
                className="d-btn d-btn-red"
                onClick={p.handleSaveProfile}
                disabled={p.saving}
              >
                {p.saving ? 'Saving…' : 'Save Profile'}
              </button>
            </div>
          </div>

          {/* PREFERENCES */}
          <div className={`d-settings-panel${tab === 'preferences' ? ' d-active' : ''}`}>
            <h3>Preferences</h3>
            <p className="d-lede">How the app shows up for you, by default.</p>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Default Format</div>
                <div className="d-hint">Pre-selected when you issue a challenge.</div>
              </div>
              <div>
                <div className="d-pair-toggle">
                  <button
                    className={p.defaultFormat === 'singles' ? 'd-active' : ''}
                    onClick={() => p.setDefaultFormat('singles')}
                  >
                    Singles
                  </button>
                  <button
                    className={p.defaultFormat === 'doubles' ? 'd-active' : ''}
                    onClick={() => p.setDefaultFormat('doubles')}
                  >
                    Doubles
                  </button>
                </div>
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Preferred Days</div>
                <div className="d-hint">Used by session matchmaking.</div>
              </div>
              <div>
                <div className="d-day-row">
                  {DAYS.map((d) => (
                    <button
                      key={d}
                      className={`d-day-btn${p.preferredDays.includes(d) ? ' d-selected' : ''}`}
                      onClick={() =>
                        p.setPreferredDays(
                          p.preferredDays.includes(d)
                            ? p.preferredDays.filter((x) => x !== d)
                            : [...p.preferredDays, d]
                        )
                      }
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Leaderboard Default</div>
                <div className="d-hint">Which board opens first.</div>
              </div>
              <div>
                <div className="d-pair-toggle">
                  <button
                    className={p.leaderboardDefault === 'singles' ? 'd-active' : ''}
                    onClick={() => p.setLeaderboardDefault('singles')}
                  >
                    Singles
                  </button>
                  <button
                    className={p.leaderboardDefault === 'doubles' ? 'd-active' : ''}
                    onClick={() => p.setLeaderboardDefault('doubles')}
                  >
                    Doubles
                  </button>
                </div>
              </div>
            </div>
            <div className="d-save-row">
              <button
                type="button"
                className="d-btn d-btn-red"
                onClick={p.handleSavePreferences}
                disabled={p.saving}
              >
                {p.saving ? 'Saving…' : 'Save Preferences'}
              </button>
            </div>
          </div>

          {/* NOTIFICATIONS */}
          <div className={`d-settings-panel${tab === 'notifications' ? ' d-active' : ''}`}>
            <h3>Notifications</h3>
            <p className="d-lede">
              When the app pings you. Email is the default; push needs browser permission.
            </p>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Someone challenges me</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.pushChallenges ? ' d-on' : ''}`}
                  onClick={() => p.setPushChallenges(!p.pushChallenges)}
                  role="switch"
                  aria-checked={p.pushChallenges}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Match result needs my confirmation</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.pushMatches ? ' d-on' : ''}`}
                  onClick={() => p.setPushMatches(!p.pushMatches)}
                  role="switch"
                  aria-checked={p.pushMatches}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">A new session is posted</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.pushSessions ? ' d-on' : ''}`}
                  onClick={() => p.setPushSessions(!p.pushSessions)}
                  role="switch"
                  aria-checked={p.pushSessions}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Admin announcement sent</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.pushAnnounce ? ' d-on' : ''}`}
                  onClick={() => p.setPushAnnounce(!p.pushAnnounce)}
                  role="switch"
                  aria-checked={p.pushAnnounce}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Channels</div>
                <div className="d-hint">How notifications reach you.</div>
              </div>
              <div />
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Email</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.emailChannel ? ' d-on' : ''}`}
                  onClick={() => p.setEmailChannel(!p.emailChannel)}
                  role="switch"
                  aria-checked={p.emailChannel}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Browser Push</div>
                {!p.pushSupported && (
                  <div className="d-hint">Not supported in this browser.</div>
                )}
              </div>
              <div>
                <div
                  className={`d-toggle${p.pushEnabled ? ' d-on' : ''}${!p.pushSupported ? ' d-disabled' : ''}`}
                  onClick={p.pushSupported ? p.handlePushToggle : undefined}
                  style={!p.pushSupported ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  role="switch"
                  aria-checked={p.pushEnabled}
                />
              </div>
            </div>
            <div className="d-save-row">
              <button
                type="button"
                className="d-btn d-btn-red"
                onClick={p.handleSavePreferences}
                disabled={p.saving}
              >
                {p.saving ? 'Saving…' : 'Save Notifications'}
              </button>
            </div>
          </div>

          {/* CHALLENGES */}
          <div className={`d-settings-panel${tab === 'challenges' ? ' d-active' : ''}`}>
            <h3>Challenges</h3>
            <p className="d-lede">How challenges flow through your inbox.</p>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Auto-accept within ±50 ELO</div>
                <div className="d-hint">Skip the inbox for closely-matched opponents.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.autoAccept ? ' d-on' : ''}`}
                  onClick={() => p.setAutoAccept(!p.autoAccept)}
                  role="switch"
                  aria-checked={p.autoAccept}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Open to doubles partners</div>
                <div className="d-hint">Receive doubles challenge invitations.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.openDoubles ? ' d-on' : ''}`}
                  onClick={() => p.setOpenDoubles(!p.openDoubles)}
                  role="switch"
                  aria-checked={p.openDoubles}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Cross-skill matches</div>
                <div className="d-hint">Allow opponents more than 200 ELO away.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.crossSkill ? ' d-on' : ''}`}
                  onClick={() => p.setCrossSkill(!p.crossSkill)}
                  role="switch"
                  aria-checked={p.crossSkill}
                />
              </div>
            </div>
            <div className="d-save-row">
              <button
                type="button"
                className="d-btn d-btn-red"
                onClick={p.handleSavePreferences}
                disabled={p.saving}
              >
                {p.saving ? 'Saving…' : 'Save Challenge Prefs'}
              </button>
            </div>
          </div>

          {/* ACCOUNT */}
          <div className={`d-settings-panel${tab === 'account' ? ' d-active' : ''}`}>
            <h3>Account</h3>
            <p className="d-lede">Visibility, season recap emails, and signing out.</p>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Show me on leaderboard</div>
                <div className="d-hint">Hidden players still earn ELO but don&apos;t appear publicly.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.showOnLeaderboard ? ' d-on' : ''}`}
                  onClick={() => p.setShowOnLeaderboard(!p.showOnLeaderboard)}
                  role="switch"
                  aria-checked={p.showOnLeaderboard}
                />
              </div>
            </div>
            <div className="d-settings-group">
              <div>
                <div className="d-label">Weekly recap email</div>
                <div className="d-hint">Summary of your matches every Monday morning.</div>
              </div>
              <div>
                <div
                  className={`d-toggle${p.emailRecap ? ' d-on' : ''}`}
                  onClick={() => p.setEmailRecap(!p.emailRecap)}
                  role="switch"
                  aria-checked={p.emailRecap}
                />
              </div>
            </div>
            <div className="d-save-row" style={{ display: 'flex', gap: 12 }}>
              <button
                type="button"
                className="d-btn d-btn-red"
                onClick={p.handleSavePrivacy}
                disabled={p.saving}
              >
                {p.saving ? 'Saving…' : 'Save Account'}
              </button>
              <button
                type="button"
                className="d-btn d-btn-danger"
                onClick={p.handleSignOut}
                disabled={p.signingOut}
              >
                {p.signingOut ? 'Signing out…' : 'Sign Out'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
