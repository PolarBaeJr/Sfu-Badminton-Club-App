'use client';

import { useState, useTransition } from 'react';
import { completeOnboarding } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';

const TOTAL_STEPS = 3;

type Direction = 'forward' | 'back';

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [direction, setDirection] = useState<Direction>('forward');
  const [animating, setAnimating] = useState(false);

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  function go(toStep: number) {
    if (animating) return;
    if (toStep < 1 || toStep > TOTAL_STEPS) return;
    setDirection(toStep > step ? 'forward' : 'back');
    setAnimating(true);
    // Step transition: 250ms cubic-bezier(0.4,0,0.2,1) per spec
    setTimeout(() => {
      setStep(toStep);
      setAnimating(false);
    }, 250);
  }

  async function handleComplete() {
    if (!acknowledged) return;
    setSubmitting(true);
    try {
      await completeOnboarding({
        full_name: name,
        display_name: displayName || undefined,
        phone: phone || undefined,
      });
      // Brief delay so the user sees success state before navigating
      startTransition(() => router.push('/feed'));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to complete onboarding', 'error');
      setSubmitting(false);
    }
  }

  const progressPct = (step / TOTAL_STEPS) * 100;

  // Step transition classes (slide ±40px + opacity per spec)
  const stepStyle: React.CSSProperties = animating
    ? {
        opacity: 0,
        transform: `translateX(${direction === 'forward' ? -40 : 40}px)`,
        transition: 'opacity 200ms cubic-bezier(0.4,0,0.2,1), transform 200ms cubic-bezier(0.4,0,0.2,1)',
      }
    : {
        opacity: 1,
        transform: 'translateX(0)',
        transition: 'opacity 200ms cubic-bezier(0.4,0,0.2,1), transform 200ms cubic-bezier(0.4,0,0.2,1)',
      };

  const fieldLabel: React.CSSProperties = {
    display: 'block',
    fontSize: 9,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: 'var(--dim)',
    fontWeight: 700,
    marginBottom: 8,
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: '#0D0D0D',
    border: '1px solid rgba(255,255,255,0.10)',
    color: '#F0F0F0',
    fontFamily: 'var(--font-body)',
    fontSize: 14,
    padding: '12px 14px',
    outline: 'none',
    transition: 'border-color 150ms ease-out',
    boxSizing: 'border-box',
  };

  const btnRed: React.CSSProperties = {
    background: 'var(--red)',
    color: '#fff',
    fontFamily: 'var(--font-display)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    padding: '12px 18px',
    border: 0,
    cursor: 'pointer',
    transition: 'background 150ms ease-out, opacity 150ms ease-out',
  };

  const btnBack: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--muted)',
    fontFamily: 'var(--font-display)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    border: 0,
    cursor: 'pointer',
    padding: '10px 14px',
    transition: 'color 150ms',
  };

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-y-auto"
      style={{ background: 'var(--bg)', zIndex: 200 }}
    >
      {/* Diagonal grid texture */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 39px, rgba(255,255,255,0.03) 39px, rgba(255,255,255,0.03) 40px)',
          zIndex: 0,
        }}
      />

      {/* Progress + step counter */}
      <div className="relative pt-7 pb-4 text-center" style={{ zIndex: 2 }}>
        <div
          className="font-bold uppercase mb-3"
          style={{ fontSize: 9, letterSpacing: '0.22em', color: 'var(--dim)' }}
        >
          Step {step} of {TOTAL_STEPS}
        </div>
        <div
          className="relative mx-auto"
          style={{ height: 2, background: 'var(--surface2)', maxWidth: 480 }}
        >
          <span
            className="absolute left-0 top-0 bottom-0"
            style={{
              background: 'var(--red)',
              transition: 'width 240ms ease-out',
              width: `${progressPct}%`,
            }}
          />
        </div>
      </div>

      {/* Stage */}
      <div
        className="flex-1 flex items-center justify-center px-8 py-10 relative min-h-0"
        style={{ zIndex: 2 }}
      >
        <div className="w-full" style={{ maxWidth: 520, ...stepStyle }}>
          {step === 1 && (
            <>
              <div className="flex items-center gap-[14px]">
                <span aria-hidden style={{ width: 3, height: 14, background: 'var(--red)' }} />
                <span
                  className="uppercase font-bold"
                  style={{ fontSize: 10, letterSpacing: '0.25em', color: 'var(--red)' }}
                >
                  Welcome
                </span>
              </div>
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 64,
                  lineHeight: 0.9,
                  color: 'var(--ink)',
                  letterSpacing: '-0.02em',
                  marginTop: 16,
                }}
              >
                You&apos;re in.
              </h1>
              <p
                className="mt-5"
                style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 440 }}
              >
                Three quick steps. Then you&apos;re ready to play.
              </p>

              <div className="mt-7 flex flex-col gap-[14px]">
                {[
                  { num: '01', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Tell us your name</strong> so other players know who they&apos;re challenging.</> },
                  { num: '02', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Add a phone number</strong> for session reminders. Optional.</> },
                  { num: '03', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Confirm club rules</strong> and you&apos;re on the ladder.</> },
                ].map((row, i) => (
                  <div
                    key={row.num}
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: '32px 1fr',
                      gap: 16,
                      padding: '12px 0',
                      borderTop: i === 0 ? 0 : '1px solid var(--hairline)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: 18,
                        color: 'var(--red)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >{row.num}</span>
                    <span style={{ color: 'var(--text)', fontSize: 13, lineHeight: 1.5 }}>{row.text}</span>
                  </div>
                ))}
              </div>

              <div className="mt-9 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => go(2)}
                  disabled={animating}
                  style={btnRed}
                >Get started →</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex items-center gap-[14px]">
                <span aria-hidden style={{ width: 3, height: 14, background: 'var(--red)' }} />
                <span
                  className="uppercase font-bold"
                  style={{ fontSize: 10, letterSpacing: '0.25em', color: 'var(--red)' }}
                >
                  Your profile
                </span>
              </div>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 48,
                  lineHeight: 0.9,
                  color: 'var(--ink)',
                  letterSpacing: '-0.02em',
                  marginTop: 16,
                }}
              >
                Who plays.
              </h2>
              <p className="mt-4" style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 440 }}>
                Your name is how matches credit you. Display name and phone are optional.
              </p>

              <div className="mt-6 flex flex-col gap-[18px]">
                <div>
                  <label htmlFor="name" style={fieldLabel}>Full name *</label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="First Last"
                    required
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--red)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
                  />
                </div>
                <div>
                  <label htmlFor="displayName" style={fieldLabel}>Display name <span style={{ color: 'var(--faint)' }}>(optional)</span></label>
                  <input
                    id="displayName"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="What people call you on court"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--red)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
                  />
                </div>
                <div>
                  <label htmlFor="phone" style={fieldLabel}>Phone <span style={{ color: 'var(--faint)' }}>(optional)</span></label>
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="For session reminders"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--red)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
                  />
                </div>
              </div>

              <div className="mt-9 flex items-center gap-3">
                <button type="button" onClick={() => go(1)} disabled={animating} style={btnBack}>← Back</button>
                <button
                  type="button"
                  onClick={() => go(3)}
                  disabled={animating || name.trim().length < 2}
                  style={{ ...btnRed, opacity: name.trim().length < 2 ? 0.4 : 1, cursor: name.trim().length < 2 ? 'not-allowed' : 'pointer' }}
                >Continue →</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex items-center gap-[14px]">
                <span aria-hidden style={{ width: 3, height: 14, background: 'var(--red)' }} />
                <span
                  className="uppercase font-bold"
                  style={{ fontSize: 10, letterSpacing: '0.25em', color: 'var(--red)' }}
                >
                  Club rules
                </span>
              </div>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 48,
                  lineHeight: 0.9,
                  color: 'var(--ink)',
                  letterSpacing: '-0.02em',
                  marginTop: 16,
                }}
              >
                The basics.
              </h2>
              <p className="mt-4" style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 440 }}>
                Five things we ask of every player.
              </p>

              <div className="mt-7 flex flex-col gap-[14px]">
                {[
                  { num: '01', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Show up.</strong> If you sign up for a session, attend or cancel ≥2h ahead.</> },
                  { num: '02', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Submit scores</strong> within 24h of any rated match — both players confirm.</> },
                  { num: '03', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Dispute respectfully.</strong> Flag the score, don&apos;t argue at court.</> },
                  { num: '04', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Climb honestly.</strong> ELO only counts when both sides agree on the result.</> },
                  { num: '05', text: <><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Have fun.</strong> The ranking is real but the club comes first.</> },
                ].map((row, i) => (
                  <div
                    key={row.num}
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: '32px 1fr',
                      gap: 16,
                      padding: '12px 0',
                      borderTop: i === 0 ? 0 : '1px solid var(--hairline)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: 18,
                        color: 'var(--red)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >{row.num}</span>
                    <span style={{ color: 'var(--text)', fontSize: 13, lineHeight: 1.5 }}>{row.text}</span>
                  </div>
                ))}
              </div>

              <label
                className="mt-7 flex items-start gap-3 cursor-pointer select-none"
                style={{ fontSize: 13, color: 'var(--text)' }}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-[3px]"
                  style={{
                    accentColor: 'var(--red)',
                    width: 16,
                    height: 16,
                  }}
                />
                <span>I&apos;ve read these and I&apos;m in.</span>
              </label>

              <div className="mt-9 flex items-center gap-3">
                <button type="button" onClick={() => go(2)} disabled={animating || submitting} style={btnBack}>← Back</button>
                <button
                  type="button"
                  onClick={handleComplete}
                  disabled={!acknowledged || submitting || animating}
                  style={{
                    ...btnRed,
                    opacity: !acknowledged || submitting ? 0.4 : 1,
                    cursor: !acknowledged || submitting ? 'not-allowed' : 'pointer',
                  }}
                >{submitting ? 'Setting up…' : "I'm ready →"}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
