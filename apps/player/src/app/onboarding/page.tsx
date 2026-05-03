'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { completeOnboarding } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { AuthHeader, AuthShell } from '@/components/v2/atoms-layout';
import { AuthField, CTAButton } from '@/components/v2/atoms-form';

const TOTAL_STEPS = 5;

const SKILLS = [
  { v: 'beginner', t: 'Beginner', d: 'New to the sport. Still getting the hang of serves & rallies.' },
  { v: 'casual', t: 'Casual', d: 'Play for fun. Comfortable with rallies, learning strategy.' },
  { v: 'intermediate', t: 'Intermediate', d: 'Confident in singles & doubles. Have a solid clear & smash.' },
  { v: 'advanced', t: 'Advanced', d: 'Tournament experience. Competitive in regional/club events.' },
] as const;

const STARTING_ELO: Record<string, number> = {
  beginner: 1100,
  casual: 1300,
  intermediate: 1500,
  advanced: 1700,
};

type SkillKey = (typeof SKILLS)[number]['v'];
type Plays = 'singles' | 'doubles' | 'both';

export default function OnboardingPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(0);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [skill, setSkill] = useState<SkillKey | ''>('');
  const [plays, setPlays] = useState<Plays | ''>('');
  const [goal, setGoal] = useState('');
  const [notif, setNotif] = useState(true);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const progress = ((step + 1) / (TOTAL_STEPS + 1)) * 100;

  function validate() {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!email.trim()) e.email = 'Required';
      else if (!/.+@sfu\.ca$/i.test(email.trim())) e.email = 'Must be a @sfu.ca email';
      if (!password) e.password = 'Required';
      else if (password.length < 8) e.password = 'At least 8 characters';
    }
    if (step === 2) {
      if (!name.trim()) e.name = 'Required';
      if (!studentId.trim()) e.studentId = 'Required';
      else if (!/^\d{9}$/.test(studentId.trim())) e.studentId = '9-digit SFU ID';
    }
    if (step === 3 && !skill) e.skill = 'Pick one';
    if (step === 4 && !plays) e.plays = 'Pick one';
    setErrs(e);
    return Object.keys(e).length === 0;
  }

  function next() {
    if (validate()) {
      setStep((s) => s + 1);
      setErrs({});
    }
  }

  function back() {
    setStep((s) => s - 1);
    setErrs({});
  }

  async function submit() {
    if (!validate()) return;
    setSubmitting(true);
    try {
      await completeOnboarding({
        full_name: name,
        skill_level: skill || undefined,
        format_preference: plays || undefined,
        goal: goal || undefined,
        sfu_student_id: studentId || undefined,
      });
      setStep(5);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to complete onboarding', 'error');
      setSubmitting(false);
    }
  }

  function enterApp() {
    startTransition(() => router.push('/feed'));
  }

  // ── Step 0: welcome ───────────────────────────────────────────
  if (step === 0) {
    return (
      <AuthShell progress={progress}>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow={`Step 1 of ${TOTAL_STEPS}`}
            title={
              <>
                Welcome
                <br />
                to the club.
              </>
            }
            sub="Five quick steps to get you on the leaderboard. Takes about 90 seconds."
            onBack={() => router.push('/login')}
          />
          <div
            style={{
              marginTop: 28,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              background: 'var(--hairline)',
              border: '1px solid var(--hairline)',
            }}
          >
            {[
              { n: '01', l: 'Account', d: 'Email + password' },
              { n: '02', l: 'Identity', d: 'Name + SFU ID' },
              { n: '03', l: 'Skill', d: 'Self-rated level' },
              { n: '04', l: 'Preferences', d: 'How you play' },
              { n: '05', l: 'Confirm', d: 'Verify email' },
            ].map((r) => (
              <div
                key={r.n}
                style={{
                  background: 'var(--surface2)',
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--red)',
                    letterSpacing: '0.06em',
                  }}
                >
                  {r.n}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{r.l}</div>
                  <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 2 }}>{r.d}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 28 }}>
            <CTAButton size="lg" full onClick={() => setStep(1)}>
              Get Started
            </CTAButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Step 1: account ───────────────────────────────────────────
  if (step === 1) {
    return (
      <AuthShell progress={progress}>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow={`Step 2 of ${TOTAL_STEPS}`}
            title="Create account."
            sub="Use your SFU email — it's how we verify membership."
            onBack={back}
          />
          <div style={{ marginTop: 28 }}>
            <AuthField
              label="SFU Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@sfu.ca"
              error={errs.email}
              autoFocus
            />
            <AuthField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="At least 8 characters"
              error={errs.password}
              hint="Use 8+ characters with a mix of letters & numbers."
            />
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 28 }}>
            <CTAButton size="lg" full onClick={next}>
              Continue
            </CTAButton>
            <div
              style={{
                marginTop: 16,
                fontSize: 11,
                color: 'var(--dim)',
                textAlign: 'center',
                lineHeight: 1.55,
              }}
            >
              By continuing you agree to the club&apos;s{' '}
              <span style={{ color: 'var(--text)', textDecoration: 'underline' }}>Code of Conduct</span>.
            </div>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Step 2: identity ──────────────────────────────────────────
  if (step === 2) {
    return (
      <AuthShell progress={progress}>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow={`Step 3 of ${TOTAL_STEPS}`}
            title="Who are you?"
            sub="Your name appears on the leaderboard. Your SFU ID stays private — admins use it for membership checks only."
            onBack={back}
          />
          <div style={{ marginTop: 28 }}>
            <AuthField
              label="Full Name"
              value={name}
              onChange={setName}
              placeholder="e.g. Alex Tran"
              error={errs.name}
              autoFocus
            />
            <AuthField
              label="SFU Student ID"
              value={studentId}
              onChange={setStudentId}
              placeholder="9 digits"
              error={errs.studentId}
              hint="Found on your SFU ID card."
            />
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 28 }}>
            <CTAButton size="lg" full onClick={next}>
              Continue
            </CTAButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Step 3: skill ─────────────────────────────────────────────
  if (step === 3) {
    return (
      <AuthShell progress={progress}>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow={`Step 4 of ${TOTAL_STEPS}`}
            title={
              <>
                How do you
                <br />
                play?
              </>
            }
            sub="Pick the level that fits today. Your real ELO is set by your matches — this is just where we start you."
            onBack={back}
          />
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {SKILLS.map((s) => {
              const active = skill === s.v;
              return (
                <button
                  key={s.v}
                  type="button"
                  onClick={() => {
                    setSkill(s.v);
                    setErrs({});
                  }}
                  style={{
                    background: active ? 'rgba(var(--red-rgb), 0.10)' : 'var(--surface2)',
                    border: '1px solid ' + (active ? 'var(--red)' : 'var(--hairline)'),
                    padding: '14px 16px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    color: 'var(--ink)',
                    fontFamily: 'inherit',
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      border: '1.5px solid ' + (active ? 'var(--red)' : 'var(--dim)'),
                      borderRadius: '50%',
                      flexShrink: 0,
                      position: 'relative',
                    }}
                  >
                    {active && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 3,
                          background: 'var(--red)',
                          borderRadius: '50%',
                        }}
                      />
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{s.t}</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 3, lineHeight: 1.4 }}>
                      {s.d}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {errs.skill && (
            <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 10, fontWeight: 600 }}>
              ↑ {errs.skill}
            </div>
          )}
          <div style={{ marginTop: 'auto', paddingTop: 28 }}>
            <CTAButton size="lg" full onClick={next}>
              Continue
            </CTAButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Step 4: preferences ───────────────────────────────────────
  if (step === 4) {
    const opts: { v: Plays; t: string }[] = [
      { v: 'singles', t: 'Singles' },
      { v: 'doubles', t: 'Doubles' },
      { v: 'both', t: 'Both' },
    ];
    return (
      <AuthShell progress={progress}>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow={`Step 5 of ${TOTAL_STEPS}`}
            title="Last bit."
            sub="We use these to match you with the right opponents and sessions."
            onBack={back}
          />
          <div style={{ marginTop: 28 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                color: errs.plays ? 'var(--red)' : 'var(--dim)',
                marginBottom: 8,
              }}
            >
              Format you prefer
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {opts.map((p) => {
                const active = plays === p.v;
                return (
                  <button
                    key={p.v}
                    type="button"
                    onClick={() => {
                      setPlays(p.v);
                      setErrs({});
                    }}
                    style={{
                      background: active ? 'var(--red)' : 'var(--surface2)',
                      border: '1px solid ' + (active ? 'var(--red)' : 'var(--hairline)'),
                      color: 'var(--ink)',
                      padding: '14px',
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {p.t}
                  </button>
                );
              })}
            </div>
            {errs.plays && (
              <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 8, fontWeight: 600 }}>
                ↑ {errs.plays}
              </div>
            )}

            <div style={{ marginTop: 28 }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: '1.5px',
                  textTransform: 'uppercase',
                  color: 'var(--dim)',
                  marginBottom: 8,
                }}
              >
                Goal (optional)
              </div>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Make top 10 by end of season"
                rows={3}
                style={{
                  width: '100%',
                  background: 'var(--surface1)',
                  border: '1px solid var(--hairline)',
                  color: 'var(--ink)',
                  fontSize: 13,
                  padding: '12px 14px',
                  resize: 'none',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                marginTop: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: 'var(--surface2)',
                border: '1px solid var(--hairline)',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Notifications</div>
                <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 2 }}>
                  Challenges, sessions &amp; match results.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNotif(!notif)}
                style={{
                  width: 40,
                  height: 22,
                  borderRadius: 0,
                  background: notif ? 'var(--red)' : 'var(--hairline)',
                  border: 0,
                  position: 'relative',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: notif ? 20 : 2,
                    width: 18,
                    height: 18,
                    background: '#F2F2F2',
                    transition: 'left 160ms',
                  }}
                />
              </button>
            </div>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: 28 }}>
            <CTAButton size="lg" full disabled={submitting} onClick={() => void submit()}>
              {submitting ? 'Creating account…' : 'Create Account'}
            </CTAButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Step 5: confirmation ──────────────────────────────────────
  return (
    <AuthShell progress={100}>
      <div
        style={{
          flex: 1,
          padding: '24px 24px 28px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            border: '1px solid #4ade80',
            color: '#4ade80',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 36,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          ✓
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '2.4px',
            textTransform: 'uppercase',
            color: 'var(--red)',
            marginTop: 22,
          }}
        >
          You&apos;re in
        </div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: '-0.6px',
            lineHeight: 1.05,
            marginTop: 8,
          }}
        >
          Welcome,
          <br />
          {name.split(' ')[0] || 'player'}.
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text)',
            lineHeight: 1.55,
            marginTop: 14,
            maxWidth: 300,
          }}
        >
          We sent a verification link to <strong style={{ color: 'var(--ink)' }}>{email}</strong>. Tap it to unlock match
          logging — you can browse the app meanwhile.
        </div>
        <div
          style={{
            marginTop: 28,
            width: '100%',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1,
            background: 'var(--hairline)',
            border: '1px solid var(--hairline)',
          }}
        >
          <div style={{ background: 'var(--surface2)', padding: 14 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1.4px',
                textTransform: 'uppercase',
                color: 'var(--dim)',
              }}
            >
              Starting ELO
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 18,
                fontWeight: 700,
                marginTop: 4,
              }}
            >
              {STARTING_ELO[skill || 'casual'] ?? 1500}
            </div>
          </div>
          <div style={{ background: 'var(--surface2)', padding: 14 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1.4px',
                textTransform: 'uppercase',
                color: 'var(--dim)',
              }}
            >
              Format
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 13,
                fontWeight: 700,
                marginTop: 4,
                textTransform: 'capitalize',
              }}
            >
              {plays || '—'}
            </div>
          </div>
          <div style={{ background: 'var(--surface2)', padding: 14 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1.4px',
                textTransform: 'uppercase',
                color: 'var(--dim)',
              }}
            >
              Status
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 13,
                fontWeight: 700,
                marginTop: 4,
                color: '#fbbf24',
              }}
            >
              Pending
            </div>
          </div>
        </div>
        <div style={{ marginTop: 28, width: '100%' }}>
          <CTAButton size="lg" full onClick={enterApp}>
            Enter the App
          </CTAButton>
        </div>
        {/* keep notif preference visible (used at submit time) */}
        <div hidden>{String(notif)}</div>
        <div hidden>{goal}</div>
      </div>
    </AuthShell>
  );
}
