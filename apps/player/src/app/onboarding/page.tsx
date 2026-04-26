'use client';

import { useState } from 'react';
import { completeOnboarding } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { User, Phone, Sparkles, Trophy, Crosshair, ChevronRight, ChevronLeft, Loader2, Rocket } from 'lucide-react';

const steps = [
  { number: 1, title: 'Profile' },
  { number: 2, title: 'Confirm' },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  async function handleComplete() {
    setLoading(true);
    try {
      await completeOnboarding({
        full_name: name,
        display_name: displayName || undefined,
        phone: phone || undefined,
      });
      router.push('/feed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  function Field({
    id,
    label,
    optional,
    icon: Icon,
    value,
    onChange,
    placeholder,
    inputMode,
  }: {
    id: string;
    label: string;
    optional?: boolean;
    icon: React.ElementType;
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    inputMode?: 'tel' | 'text';
  }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label
          htmlFor={id}
          className="mono muted"
          style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}
        >
          {label} {optional ? <span className="muted">(optional)</span> : <span style={{ color: 'var(--red)' }}>*</span>}
        </label>
        <div style={{ position: 'relative' }}>
          <Icon
            size={16}
            className="text-[var(--mute)]"
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            id={id}
            value={value}
            inputMode={inputMode}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            style={{
              width: '100%',
              padding: '12px 14px 12px 38px',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--surface)',
              fontSize: 14,
              transition: 'border .15s',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--ink)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
        background: 'var(--bg)',
      }}
      className="auth"
    >
      <div
        style={{
          padding: 80,
          background: 'var(--ink)',
          color: 'var(--bg)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
          overflow: 'hidden',
        }}
        className="auth-panel"
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(ellipse at bottom right, rgba(204,6,51,.3), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
        <div className="brand" style={{ color: '#fff', position: 'relative', zIndex: 2 }}>
          <div className="brand-mark">SB</div>
          <div className="brand-wrap">
            <div>SFU Badminton</div>
            <div className="brand-sub" style={{ color: 'rgba(255,255,255,.5)' }}>Welcome aboard</div>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 2 }}>
          <div
            className="page-eyebrow"
            style={{ color: 'rgba(255,255,255,.6)', marginBottom: 14 }}
          >
            <span className="bar" style={{ background: 'rgba(255,255,255,.6)' }} /> NEW PLAYER · GET STARTED
          </div>
          <div
            className="auth-hero"
            style={{
              fontFamily: 'var(--display)',
              fontSize: 'clamp(36px, 6vw, 72px)',
              fontWeight: 700,
              letterSpacing: '-.04em',
              lineHeight: 0.95,
            }}
          >
            Step onto<br />
            <span style={{ color: 'var(--red)' }}>the ladder.</span>
          </div>
          <div
            style={{
              maxWidth: '46ch',
              marginTop: 20,
              color: 'rgba(255,255,255,.7)',
              fontSize: 15,
              lineHeight: 1.6,
            }}
          >
            Two quick fields and you&apos;re in. Starting ELO 1200 across singles and doubles. Climb from there.
          </div>
        </div>

        <div
          className="row"
          style={{
            gap: 24,
            fontSize: 12,
            color: 'rgba(255,255,255,.5)',
            position: 'relative',
            zIndex: 2,
            fontFamily: 'var(--mono)',
            textTransform: 'uppercase',
            letterSpacing: '.1em',
          }}
        >
          <span>Starting ELO 1200</span>
          <span>Provisional K=40</span>
          <span>Unranked → Top 10</span>
        </div>
      </div>

      <div
        className="auth-form"
        style={{
          padding: 80,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 24,
          maxWidth: 520,
          width: '100%',
          margin: '0 auto',
        }}
      >
        <div>
          <div className="page-eyebrow"><span className="bar" /> STEP {step} OF 2 · {steps[step - 1]!.title.toUpperCase()}</div>
          <h2
            style={{
              fontFamily: 'var(--display)',
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '-.03em',
              margin: '8px 0 0',
            }}
          >
            {step === 1 ? 'Set up your profile' : `You're ready, ${displayName || name.split(' ')[0]}!`}
          </h2>
          <div className="page-sub" style={{ marginTop: 8 }}>
            {step === 1
              ? 'This is how other players will see you. Display name and phone are optional.'
              : 'Start exploring the club, check into sessions, and issue challenges.'}
          </div>
        </div>

        <div className="row" style={{ gap: 6 }}>
          {steps.map((s) => (
            <div
              key={s.number}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 999,
                background: step >= s.number ? 'var(--red)' : 'var(--line)',
                transition: 'background .25s',
              }}
            />
          ))}
        </div>

        {step === 1 ? (
          <>
            <Field id="name"        label="Full name"     icon={User}     value={name}        onChange={setName}        placeholder="Your full name" />
            <Field id="displayName" label="Display name"  optional icon={Sparkles} value={displayName} onChange={setDisplayName} placeholder="Nickname or gamertag" />
            <Field id="phone"       label="Phone"         optional icon={Phone}    value={phone}       onChange={(v) => setPhone(v.replace(/[^\d\s+\-()]/g, ''))} placeholder="For session reminders" inputMode="tel" />

            <button
              type="button"
              onClick={() => { if (name.length >= 2) setStep(2); }}
              disabled={name.length < 2}
              className="btn btn-primary btn-lg"
              style={{
                width: '100%',
                justifyContent: 'center',
                height: 48,
                opacity: name.length < 2 ? 0.4 : 1,
              }}
            >
              Continue <ChevronRight size={14} />
            </button>
          </>
        ) : (
          <>
            <div className="grid grid-3" style={{ gap: 12 }}>
              <div className="card-base" style={{ textAlign: 'center', padding: 16 }}>
                <div className="stat-label">STARTING ELO</div>
                <div className="stat-value" style={{ marginTop: 4 }}>1200</div>
              </div>
              <div className="card-base" style={{ textAlign: 'center', padding: 16 }}>
                <div className="stat-label">DIVISIONS</div>
                <div className="stat-value" style={{ marginTop: 4, fontSize: 18 }}>S + D</div>
              </div>
              <div className="card-base" style={{ textAlign: 'center', padding: 16 }}>
                <div className="stat-label">RANK</div>
                <div className="stat-value" style={{ marginTop: 4, fontSize: 18 }}>—</div>
              </div>
            </div>

            <div
              style={{
                background: '#FBF1DA',
                border: '1px solid rgba(201, 154, 60, 0.3)',
                borderRadius: 10,
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                fontSize: 13,
                lineHeight: 1.5,
                color: '#6E4F1A',
              }}
            >
              <Trophy size={16} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>
                <strong>Pro tip:</strong> challenge players near your ELO. Closer matchups give bigger ELO swings — and the climb is faster.
              </span>
            </div>

            <div className="row" style={{ gap: 10 }}>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="btn btn-ghost"
                style={{ height: 48 }}
              >
                <ChevronLeft size={14} /> Back
              </button>
              <button
                type="button"
                onClick={handleComplete}
                disabled={loading}
                className="btn btn-primary btn-lg"
                style={{ flex: 1, justifyContent: 'center', height: 48 }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={14} />}
                Enter the club
              </button>
            </div>
          </>
        )}

        <div className="muted" style={{ fontSize: 11, textAlign: 'center', fontFamily: 'var(--mono)', letterSpacing: '.08em' }}>
          ACCOUNT PENDING APPROVAL · YOU&apos;LL GET AN EMAIL ONCE YOU&apos;RE LIVE
        </div>
      </div>
    </div>
  );
}
