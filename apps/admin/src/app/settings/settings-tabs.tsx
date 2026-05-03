'use client';

import { useState } from 'react';

type TabKey = 'general' | 'elo' | 'matches' | 'notifications' | 'admins';

interface Defaults {
  startingElo: number;
  kSingles: number;
  kDoubles: number;
  eloFloor: number;
  provisional: number;
  submissionWindow: number;
  disputeWindow: number;
  noShowPenalty: number;
  softReset: boolean;
}

interface AdminRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
}

export function SettingsTabs({
  defaults,
  admins,
  currentAdminEmail,
}: {
  defaults: Defaults;
  admins: AdminRow[];
  currentAdminEmail: string;
}) {
  const [tab, setTab] = useState<TabKey>('general');

  // General
  const [clubName, setClubName] = useState('SFU Badminton Club');
  const [shortCode, setShortCode] = useState('SFU');
  const [tagline, setTagline] = useState('Competitive Ladder · Established 2024');
  const [tz, setTz] = useState('America/Vancouver (PDT, UTC−7)');
  const [publicVis, setPublicVis] = useState(true);

  // ELO
  const [startingElo, setStartingElo] = useState(String(defaults.startingElo));
  const [kSingles, setKSingles] = useState(String(defaults.kSingles));
  const [kDoubles, setKDoubles] = useState(String(defaults.kDoubles));
  const [eloFloor, setEloFloor] = useState(String(defaults.eloFloor));
  const [provisional, setProvisional] = useState(String(defaults.provisional));
  const [softReset, setSoftReset] = useState(defaults.softReset);
  const [decay, setDecay] = useState(false);

  // Matches
  const [submissionWindow, setSubmissionWindow] = useState(String(defaults.submissionWindow));
  const [disputeWindow, setDisputeWindow] = useState(String(defaults.disputeWindow));
  const [requireBothConfirm, setRequireBothConfirm] = useState(true);
  const [scoreFormat, setScoreFormat] = useState('Best of 3 to 21 · Win by 2');
  const [noShowPenalty, setNoShowPenalty] = useState(String(defaults.noShowPenalty));
  const [crossSkill, setCrossSkill] = useState(true);

  // Notifications
  const [notifMatch, setNotifMatch] = useState(true);
  const [notifDispute, setNotifDispute] = useState(true);
  const [notifWeekly, setNotifWeekly] = useState(true);
  const [notifSession, setNotifSession] = useState(false);
  const [replyTo, setReplyTo] = useState('admin@sfubadminton.club');
  const [emailFooter, setEmailFooter] = useState(
    'SFU Badminton Club · Burnaby, BC · Reply STOP to unsubscribe.'
  );

  // Admins
  const [inviteEmail, setInviteEmail] = useState('');
  const [twoFactor, setTwoFactor] = useState(true);

  const tabs: { id: TabKey; label: string; sub: string }[] = [
    { id: 'general', label: 'General', sub: 'Club identity & branding' },
    { id: 'elo', label: 'ELO & Ranking', sub: 'Scoring formulas' },
    { id: 'matches', label: 'Matches', sub: 'Submission & disputes' },
    { id: 'notifications', label: 'Notifications', sub: 'Email & push' },
    { id: 'admins', label: 'Admins', sub: 'Roles & access' },
  ];

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 48px 28px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <div />
        <button type="button" style={btnRedStyle} onClick={() => alert('Saved (local-only for now)')}>
          Save Changes
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr',
          minHeight: 600,
        }}
      >
        <div
          style={{
            background: 'var(--surface1)',
            borderRight: '1px solid var(--hairline)',
            padding: '18px 0',
          }}
        >
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 24px',
                  fontSize: 11,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  color: active ? 'var(--ink)' : 'var(--muted)',
                  borderLeft: `2px solid ${active ? 'var(--red)' : 'transparent'}`,
                  background: active ? 'rgba(204,0,0,0.04)' : 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t.label}
                <span
                  style={{
                    display: 'block',
                    fontSize: 9,
                    letterSpacing: '0.16em',
                    color: 'var(--faint)',
                    marginTop: 3,
                    fontWeight: 500,
                  }}
                >
                  {t.sub}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ padding: '36px 48px' }}>
          {tab === 'general' && (
            <Panel title="General" lede="The basic identity of your club. These values appear on player-facing pages and exported PDFs.">
              <Group label="Club Name" hint="Shown in headers, email signatures, and the player app.">
                <Field value={clubName} onChange={setClubName} />
              </Group>
              <Group label="Short Code" hint="Used in match IDs and URLs. Three letters, uppercase.">
                <Field value={shortCode} onChange={(v) => setShortCode(v.toUpperCase())} maxStyle={{ maxWidth: 100 }} />
              </Group>
              <Group label="Tagline" hint="A one-line descriptor displayed below the logo.">
                <Field value={tagline} onChange={setTagline} />
              </Group>
              <Group label="Time Zone" hint="All match times and audit logs use this zone.">
                <Field value={tz} onChange={setTz} maxStyle={{ maxWidth: 320 }} />
              </Group>
              <Group label="Public Visibility" hint="When on, the leaderboard is viewable without an account.">
                <Toggle on={publicVis} onChange={() => setPublicVis(!publicVis)} />
              </Group>

              <DangerZone />
            </Panel>
          )}

          {tab === 'elo' && (
            <Panel
              title="ELO & Ranking"
              lede="The math behind the ladder. Be cautious — changes affect all future matches and dispute outcomes."
            >
              <Group label="Starting ELO" hint="Assigned to all new players on approval.">
                <Field value={startingElo} onChange={setStartingElo} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group label="K-Factor" hint="How aggressively rating moves per match. Higher = more volatile.">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field value={kSingles} onChange={setKSingles} placeholder="Singles" />
                  <Field value={kDoubles} onChange={setKDoubles} placeholder="Doubles" />
                </div>
              </Group>
              <Group label="ELO Floor" hint="No player can drop below this value, regardless of losses.">
                <Field value={eloFloor} onChange={setEloFloor} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group label="Provisional Period" hint="Number of matches a new player plays at 2× K-factor.">
                <Field value={provisional} onChange={setProvisional} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group
                label="Soft Reset Between Seasons"
                hint="At season rollover, regress every rating 50% toward the starting ELO."
              >
                <Toggle on={softReset} onChange={() => setSoftReset(!softReset)} />
              </Group>
              <Group
                label="Decay for Inactive Players"
                hint="Lose 5 ELO per week after 30 days of no recorded matches."
              >
                <Toggle on={decay} onChange={() => setDecay(!decay)} />
              </Group>
            </Panel>
          )}

          {tab === 'matches' && (
            <Panel title="Matches" lede="Submission rules, dispute windows, and what counts as a valid result.">
              <Group label="Submission Window" hint="A match must be submitted within this many hours of being played.">
                <Field value={submissionWindow} onChange={setSubmissionWindow} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group label="Dispute Window" hint="After a result is posted, opponents have this long to dispute.">
                <Field value={disputeWindow} onChange={setDisputeWindow} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group
                label="Require Both Players Confirm"
                hint="Match doesn't count until both submit matching scores."
              >
                <Toggle on={requireBothConfirm} onChange={() => setRequireBothConfirm(!requireBothConfirm)} />
              </Group>
              <Group label="Allow Score Format" hint="Best-of-three sets to 21, or single game to 21.">
                <Field value={scoreFormat} onChange={setScoreFormat} maxStyle={{ maxWidth: 320 }} />
              </Group>
              <Group label="No-Show Penalty" hint="ELO deduction for missing a scheduled match without notice.">
                <Field value={noShowPenalty} onChange={setNoShowPenalty} maxStyle={{ maxWidth: 140 }} />
              </Group>
              <Group label="Cross-Skill Matches" hint="When on, players more than 200 ELO apart can still play ranked.">
                <Toggle on={crossSkill} onChange={() => setCrossSkill(!crossSkill)} />
              </Group>
            </Panel>
          )}

          {tab === 'notifications' && (
            <Panel
              title="Notifications"
              lede="When the system sends email and push notifications. Players control their own preferences in their profile."
            >
              <Group label="Match Submitted" hint="Notify the opponent when a result is posted.">
                <RowFlex>
                  <Toggle on={notifMatch} onChange={() => setNotifMatch(!notifMatch)} />
                  <Micro>Email + Push</Micro>
                </RowFlex>
              </Group>
              <Group label="Dispute Filed" hint="Notify all admins when a player opens a dispute.">
                <RowFlex>
                  <Toggle on={notifDispute} onChange={() => setNotifDispute(!notifDispute)} />
                  <Micro>Email + Push</Micro>
                </RowFlex>
              </Group>
              <Group
                label="Weekly Recap"
                hint="Sunday evening: top movers, biggest upsets, your week's results."
              >
                <RowFlex>
                  <Toggle on={notifWeekly} onChange={() => setNotifWeekly(!notifWeekly)} />
                  <Micro>Email only</Micro>
                </RowFlex>
              </Group>
              <Group
                label="Session Reminder"
                hint="Push notification 2 hours before a session you're registered for."
              >
                <RowFlex>
                  <Toggle on={notifSession} onChange={() => setNotifSession(!notifSession)} />
                  <Micro>Push only</Micro>
                </RowFlex>
              </Group>
              <Group label="Reply-To Address" hint="Replies to system emails are routed here.">
                <Field value={replyTo} onChange={setReplyTo} />
              </Group>
              <Group label="Email Footer" hint="Appended to every outgoing message.">
                <textarea
                  value={emailFooter}
                  onChange={(e) => setEmailFooter(e.target.value)}
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--hairline)',
                    color: 'var(--ink)',
                    padding: '10px 12px',
                    fontFamily: 'var(--font-body)',
                    fontSize: 13,
                    width: '100%',
                    resize: 'vertical',
                    minHeight: 80,
                    boxSizing: 'border-box',
                  }}
                />
              </Group>
            </Panel>
          )}

          {tab === 'admins' && (
            <Panel
              title="Admins"
              lede="Members with elevated access. Owners can delete the club; admins can resolve disputes and manage players."
            >
              {admins.length === 0 ? (
                <div
                  style={{
                    padding: '24px 0',
                    color: 'var(--muted)',
                    fontSize: 13,
                    textAlign: 'center',
                  }}
                >
                  No admins on file.
                </div>
              ) : (
                admins.map((a, i) => (
                  <div
                    key={a.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 100px 120px 80px',
                      gap: 16,
                      padding: '14px 0',
                      borderTop: i === 0 ? 0 : '1px solid var(--hairline-soft)',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ color: 'var(--ink)', fontSize: 13 }}>
                      {a.full_name}
                      <small
                        style={{
                          display: 'block',
                          color: 'var(--muted)',
                          fontSize: 11,
                          marginTop: 2,
                        }}
                      >
                        {a.email}
                      </small>
                    </div>
                    <div>
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: 10,
                          letterSpacing: '0.16em',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '3px 8px',
                          border: `1px solid ${
                            a.role === 'super_admin' ? 'rgba(204,0,0,0.30)' : 'var(--hairline)'
                          }`,
                          color:
                            a.role === 'super_admin'
                              ? 'var(--red)'
                              : a.role === 'admin'
                                ? 'var(--ink)'
                                : 'var(--muted)',
                        }}
                      >
                        {a.role === 'super_admin' ? 'Owner' : a.role === 'admin' ? 'Admin' : 'Moderator'}
                      </span>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                      Joined{' '}
                      {new Date(a.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        year: 'numeric',
                      })}
                    </div>
                    <div>
                      {a.email !== currentAdminEmail && a.role !== 'super_admin' && (
                        <a
                          href="#"
                          style={{
                            color: 'var(--muted)',
                            fontSize: 11,
                            letterSpacing: '0.14em',
                            textTransform: 'uppercase',
                            fontWeight: 600,
                          }}
                        >
                          Revoke
                        </a>
                      )}
                    </div>
                  </div>
                ))
              )}

              <Group label="Invite New Admin" hint="Send an email invite. Recipient must already be a player.">
                <RowFlex>
                  <Field value={inviteEmail} onChange={setInviteEmail} placeholder="player@email.com" />
                  <button type="button" style={btnGhostStyle}>
                    Send Invite
                  </button>
                </RowFlex>
              </Group>
              <Group
                label="Two-Factor Required"
                hint="All admins must enable 2FA before accessing this dashboard."
              >
                <Toggle on={twoFactor} onChange={() => setTwoFactor(!twoFactor)} />
              </Group>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

// ── Components ────────────────────────────────────────────────

function Panel({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 24,
          color: 'var(--ink)',
          letterSpacing: '-0.01em',
          marginBottom: 6,
        }}
      >
        {title}
      </h3>
      <p style={{ color: 'var(--muted)', fontSize: 12, maxWidth: 520, marginBottom: 28 }}>{lede}</p>
      {children}
    </div>
  );
}

function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '22px 0',
        borderTop: '1px solid var(--hairline)',
        display: 'grid',
        gridTemplateColumns: '1fr 1.4fr',
        gap: 32,
        alignItems: 'flex-start',
      }}
    >
      <div>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink)',
            fontWeight: 700,
          }}
        >
          {label}
        </div>
        {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  maxStyle,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxStyle?: React.CSSProperties;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--hairline)',
        color: 'var(--ink)',
        padding: '10px 12px',
        fontFamily: 'var(--font-body)',
        fontSize: 13,
        width: '100%',
        boxSizing: 'border-box',
        ...maxStyle,
      }}
    />
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-pressed={on}
      style={{
        width: 44,
        height: 24,
        background: on ? 'rgba(204,0,0,0.15)' : 'var(--surface2)',
        border: `1px solid ${on ? 'var(--red)' : 'var(--hairline)'}`,
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 22 : 2,
          width: 18,
          height: 18,
          background: on ? 'var(--red)' : 'var(--muted)',
          transition: 'all 150ms',
        }}
      />
    </button>
  );
}

function RowFlex({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>{children}</div>;
}

function Micro({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-body)',
        fontSize: 10,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        fontWeight: 600,
        color: 'var(--muted)',
      }}
    >
      {children}
    </span>
  );
}

function DangerZone() {
  return (
    <div
      style={{
        marginTop: 36,
        border: '1px solid rgba(204,0,0,0.3)',
        padding: 24,
        background: 'rgba(204,0,0,0.04)',
      }}
    >
      <h4
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 16,
          color: 'var(--red)',
          letterSpacing: '0.02em',
          marginBottom: 12,
        }}
      >
        Danger Zone
      </h4>
      <DangerRow
        title="Reset all ELO ratings"
        body="Every player drops to the season starting value. Match history is preserved. Cannot be undone."
        action="Reset Ratings"
      />
      <DangerRow
        title="Wipe match history"
        body="Removes every match record from the database. ELO snapshots remain. Cannot be undone."
        action="Wipe Matches"
      />
      <DangerRow
        title="Delete club"
        body="Permanently removes this club and all associated data, including audit logs. Cannot be undone."
        action="Delete Club"
      />
    </div>
  );
}

function DangerRow({ title, body, action }: { title: string; body: string; action: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 0',
        borderTop: '1px solid rgba(204,0,0,0.15)',
        gap: 24,
      }}
    >
      <div style={{ flex: 1 }}>
        <strong style={{ color: 'var(--ink)', fontSize: 13, fontWeight: 500, display: 'block' }}>
          {title}
        </strong>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{body}</p>
      </div>
      <button
        type="button"
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          padding: '10px 16px',
          background: 'transparent',
          color: 'var(--red)',
          border: '1px solid var(--red)',
          cursor: 'not-allowed',
          opacity: 0.6,
          lineHeight: 1,
        }}
        disabled
      >
        {action}
      </button>
    </div>
  );
}

const btnRedStyle: React.CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  padding: '10px 16px',
  background: 'var(--red)',
  color: '#F2F2F2',
  border: 0,
  cursor: 'pointer',
  lineHeight: 1,
};

const btnGhostStyle: React.CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  padding: '10px 16px',
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--hairline)',
  cursor: 'pointer',
  lineHeight: 1,
};
