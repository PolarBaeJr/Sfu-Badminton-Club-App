'use client';

import { useEffect, useState } from 'react';
import { completeOnboarding, getLegalDocuments } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { LegalMarkdown } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, sortLegalDocuments, CHECKIN_TOKEN_REGEX } from '@badminton/shared';
import { User, Phone, Sparkles, Trophy, ChevronRight, ChevronLeft, Loader2, Rocket } from 'lucide-react';

const steps = [
  { number: 1, title: 'Profile' },
  { number: 2, title: 'Waiver' },
  { number: 3, title: 'Confirm' },
];

// Someone can arrive here by scanning a session QR before finishing setup — the
// middleware forwards the token as ?checkin=<token> rather than dropping it.
// Finish onboarding, then do the check-in they were actually trying to do.
// Single-purpose like /login's equivalent: only a well-formed token is honoured,
// so this can never become an open redirect.
function destinationAfterOnboarding(): string {
  const token = new URLSearchParams(window.location.search).get('checkin') ?? '';
  return CHECKIN_TOKEN_REGEX.test(token) ? `/checkin/${token}` : '/feed';
}

// Defined at module scope (NOT inside OnboardingPage): a component declared
// inside the page body gets a new identity on every render, so React would
// unmount/remount the input on each keystroke and the field would lose focus.
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

// Module scope for the same focus-preservation reason as Field.
function LegalCheckbox({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      htmlFor={id}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
      />
      <span>{label}</span>
    </label>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [docs, setDocs] = useState<{ document: string; version: string; content: string }[] | null>(null);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [cocAccepted, setCocAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [ageAttested, setAgeAttested] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    getLegalDocuments()
      .then((res) => {
        if (res.ok) setDocs(sortLegalDocuments(res.data));
        else toast('Failed to load the waiver — please refresh', 'error');
      })
      .catch(() => toast('Failed to load the waiver — please refresh', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allAccepted = waiverAccepted && cocAccepted && termsAccepted && ageAttested;
  // Only the first name is required (profileSchema); mononyms are real names.
  const nameEntered = firstName.trim().length > 0;

  async function handleComplete() {
    setLoading(true);
    try {
      const res = await completeOnboarding({
        first_name: firstName,
        last_name: lastName || undefined,
        display_name: displayName || undefined,
        phone: phone || undefined,
        waiver_accepted: waiverAccepted,
        code_of_conduct_accepted: cocAccepted,
        terms_accepted: termsAccepted,
        age_attestation: ageAttested,
      });
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      router.push(destinationAfterOnboarding());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    // Onboarding is a form to complete, not a pitch to read. No full-height
    // brand panel — the member is already signed in and just needs to finish.
    <div
      className="auth"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        padding: '40px 20px',
      }}
    >
      <div
        className="auth-card"
        style={{
          width: '100%',
          maxWidth: 460,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div>
          <div className="page-eyebrow"><span className="bar" /> STEP {step} OF 3 · {steps[step - 1]!.title.toUpperCase()}</div>
          <h2
            style={{
              fontFamily: 'var(--display)',
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '-.03em',
              margin: '8px 0 0',
            }}
          >
            {step === 1
              ? 'Set up your profile'
              : step === 2
              ? 'Waiver & club policies'
              : `You're ready, ${displayName || firstName}!`}
          </h2>
          <div className="page-sub" style={{ marginTop: 8 }}>
            {step === 1
              ? 'This is how other players will see you. Display name and phone are optional.'
              : step === 2
              ? 'Read and accept the terms of use, privacy policy, liability waiver, and code of conduct to play.'
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
            <Field id="firstName"   label="First name"    icon={User}     value={firstName}   onChange={setFirstName}   placeholder="Your first name" />
            <Field id="lastName"    label="Last name"     optional icon={User}     value={lastName}    onChange={setLastName}    placeholder="Your last name" />
            <Field id="displayName" label="Display name"  optional icon={Sparkles} value={displayName} onChange={setDisplayName} placeholder="Nickname or gamertag" />
            <Field id="phone"       label="Phone"         optional icon={Phone}    value={phone}       onChange={(v) => setPhone(v.replace(/[^\d\s+\-()]/g, ''))} placeholder="For session reminders" inputMode="tel" />

            <button
              type="button"
              onClick={() => { if (nameEntered) setStep(2); }}
              disabled={!nameEntered}
              className="btn btn-primary btn-lg"
              style={{
                width: '100%',
                justifyContent: 'center',
                height: 48,
                opacity: nameEntered ? 1 : 0.4,
              }}
            >
              Continue <ChevronRight size={14} />
            </button>
          </>
        ) : step === 2 ? (
          <>
            <div className="card-base" style={{ maxHeight: '50vh', overflowY: 'auto', padding: 16 }}>
              {docs === null ? (
                <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <Loader2 size={14} className="animate-spin" /> Loading documents…
                </div>
              ) : (
                docs.map((doc) => (
                  <div key={doc.document} style={{ marginBottom: 20 }}>
                    <div className="card-title">{LEGAL_DOCUMENT_LABELS[doc.document as keyof typeof LEGAL_DOCUMENT_LABELS] || doc.document}</div>
                    <div className="card-sub mono">Version {doc.version}</div>
                    <LegalMarkdown content={doc.content} />
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <LegalCheckbox id="terms-accept" checked={termsAccepted} onChange={setTermsAccepted} label="I agree to the Terms of Use and Privacy Policy." />
              <LegalCheckbox id="waiver-accept" checked={waiverAccepted} onChange={setWaiverAccepted} label="I have read and accept the liability waiver." />
              <LegalCheckbox id="coc-accept" checked={cocAccepted} onChange={setCocAccepted} label="I have read and accept the code of conduct." />
              <LegalCheckbox id="age-attest" checked={ageAttested} onChange={setAgeAttested} label="I am 19 or older, or I have my parent/guardian's consent." />
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
                onClick={() => { if (allAccepted) setStep(3); }}
                disabled={!allAccepted}
                className="btn btn-primary btn-lg"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  height: 48,
                  opacity: allAccepted ? 1 : 0.4,
                }}
              >
                Continue <ChevronRight size={14} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-3" style={{ gap: 12 }}>
              <div className="card-base" style={{ textAlign: 'center', padding: 16 }}>
                <div className="stat-label">STARTING ELO</div>
                <div className="stat-value" style={{ marginTop: 4 }}>400</div>
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
                onClick={() => setStep(2)}
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
