'use client';

import { useEffect, useState } from 'react';
import { completeOnboarding, getLegalDocuments, getSkillTiers } from '@/lib/actions';
import { markPasskeyEnrolled } from '@/lib/actions/profile';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { LegalMarkdown } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, sortLegalDocuments, CHECKIN_TOKEN_REGEX, type SkillTier } from '@badminton/shared';
import type { SkillTierOption } from '@/lib/rating-tiers';
import { User, Phone, Sparkles, Trophy, ChevronRight, ChevronLeft, Loader2, Rocket, KeyRound, Check, Mail } from 'lucide-react';
import { enrollPasskey, supportsPasskeys } from '@/lib/passkey-client';
import { passkeysConfigured } from '@/lib/actions/passkeys';
import type { PasskeySetupOutcome } from '@/lib/actions/profile';
import { PASSKEY_DECLINED_THIS_SESSION_KEY } from '@/components/passkey-nudge';

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

// The skill-level question (00127). Module scope for the same
// focus-preservation reason as Field.
//
// RADIO BUTTONS, NOT A SELECT, and the whole card is the tap target. A native
// <select> on a phone opens a wheel that hides the descriptions — and the
// descriptions are the entire mechanism here. Members are unreliable judges of
// "how good am I" and reliable reporters of "have I competed", so the words
// beside each tier are what make the answer worth seeding a rating from.
//
// The starting rating is shown for each tier because it is not a secret and
// hiding it would be worse: a member who finds out afterwards that "Beginner"
// cost them 800 points has been tricked rather than asked. It also makes the
// tiers legible as a scale rather than three adjectives.
function TierChoice({
  option,
  selected,
  onSelect,
}: {
  option: SkillTierOption;
  selected: boolean;
  onSelect: (tier: SkillTier) => void;
}) {
  return (
    <label
      htmlFor={`tier-${option.tier}`}
      className="card-base"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        // >= 44px tap target: 14px padding top and bottom around a two-line
        // block clears it comfortably on the smallest phone this sees.
        padding: 14,
        cursor: 'pointer',
        borderColor: selected ? 'var(--red)' : 'var(--line)',
        transition: 'border-color .15s',
      }}
    >
      <input
        id={`tier-${option.tier}`}
        type="radio"
        name="skill-tier"
        checked={selected}
        onChange={() => onSelect(option.tier)}
        style={{ marginTop: 3, accentColor: 'var(--red)', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{option.label}</span>
          <span className="mono muted" style={{ fontSize: 11, letterSpacing: '.06em', flexShrink: 0 }}>
            START {option.elo}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
          {option.description}
        </div>
      </div>
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
  // The passkey question, asked on the last step and now REQUIRING an answer —
  // but the answer may be "no". Onboarding is the one moment the middleware
  // guarantees every member passes through exactly once (onboarding_completed),
  // so it is the only reliable place to ask; a nudge that can be ignored leaves
  // most of the club on emailed codes forever, and every code costs sender
  // reputation.
  //
  // "Answer required", not "passkey required". This same flow collects the
  // liability waiver, and it is being completed on a phone at the door on club
  // night. A hard block turns any passkey failure — a browser that reports
  // support and then refuses, a member who declines the system prompt twice,
  // a deployment missing PASSKEY_COOKIE_SECRET — into a member who cannot get
  // into the club's app at all, with no path forward and nobody to ask. An
  // explicit, recorded decline gets nearly the same enrolment rate (the choice
  // is deliberate and unavoidable, which is what actually moves the number)
  // with no way to strand anyone.
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // The ANSWER, not the credential: enrolment happens in handleComplete.
  const [passkeyWanted, setPasskeyWanted] = useState(false);
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const [passkeyDeclined, setPasskeyDeclined] = useState(false);
  // Both null until resolved, and BOTH must be true before anything is asked of
  // the member. supportsPasskeys() touches window (hence the effect, not
  // render); passkeysConfigured() asks the server whether this deployment can
  // enrol at all, because PASSKEY_COOKIE_SECRET is server-only and without it
  // the register route answers 503 — requiring an answer to a question whose
  // "yes" is broken would be exactly the stranding this design avoids.
  const [passkeySupported, setPasskeySupported] = useState<boolean | null>(null);
  const [passkeyConfigured, setPasskeyConfigured] = useState<boolean | null>(null);
  // The skill-level answer (00127). Carried in state and sent WITH
  // completeOnboarding rather than applied here, for the same ordering reason
  // as the passkey: the seed needs a ratings row and nothing creates one until
  // that call returns.
  //
  // `null` until answered, and an answer is REQUIRED to leave step 1. Defaulting
  // to Beginner would be the same as not shipping this — the strong player who
  // skips the question is exactly the person the tiers exist to place, and a
  // pre-selected safe answer is one they never have to look at. The passkey
  // step above established the pattern: require the answer, not a particular
  // answer.
  const [skillTier, setSkillTier] = useState<SkillTier | null>(null);
  // Fetched, never hardcoded — the ratings each tier seeds are admin-editable
  // on /ratings. `null` while loading; the step renders a spinner rather than
  // three wrong numbers.
  const [tiers, setTiers] = useState<SkillTierOption[] | null>(null);
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

  // Failure resolves to an empty list rather than a rejected promise, and the
  // step treats empty as "cannot ask": see skillTierAnswered. A member must
  // never be trapped on step 1 because a settings read failed — they go through
  // on the club's default rating, which is exactly where everyone started
  // before tiering existed.
  useEffect(() => {
    getSkillTiers()
      .then(setTiers)
      .catch(() => setTiers([]));
  }, []);

  useEffect(() => {
    setPasskeySupported(supportsPasskeys());
    // Failure resolves to false, not to a pending promise: an unreachable
    // server action must degrade to "we can't enrol here", which asks nothing
    // of the member, rather than leaving the last step waiting forever.
    void passkeysConfigured()
      .then(setPasskeyConfigured)
      .catch(() => setPasskeyConfigured(false));
  }, []);

  // Ask only when both halves say yes. Anything else — no WebAuthn in this
  // browser, or no passkey secret on this deployment — means the member is
  // simply told they will get emailed codes, and is required to do nothing.
  const passkeyOffered = passkeySupported === true && passkeyConfigured === true;
  const passkeyImpossible = passkeySupported === false || passkeyConfigured === false;
  // The gate on "Enter the club". Note the leading `!passkeyOffered`: while
  // either check is still resolving, and forever on a device that cannot do
  // this, the answer is already "nothing to answer" and the button is live.
  const passkeyAnswered = !passkeyOffered || passkeyWanted || passkeyAdded || passkeyDeclined;

  // What goes on the record (00121). `undefined` while we genuinely do not know
  // — better to store nothing than to guess, since the whole value of this
  // column is telling a refusal apart from an impossibility.
  function passkeyOutcome(): PasskeySetupOutcome | undefined {
    if (passkeyAdded) return 'enrolled';
    // Chose to enrol but it has not happened yet — markPasskeyEnrolled fills
    // this in once it has. Guessing 'enrolled' here would record a passkey
    // that may never exist.
    if (passkeyWanted) return undefined;
    if (passkeySupported === false) return 'unsupported';
    if (passkeyConfigured === false) return 'unavailable';
    if (passkeyDeclined) return 'declined';
    return undefined;
  }

  // Declining here holds the feed's PasskeyNudge for THIS SESSION only —
  // otherwise it asks the identical question on the very next screen. It is
  // deliberately not the nudge's permanent dismissal: the banner is the only
  // way a decliner is ever asked again, and silencing it for good would strand
  // exactly the people this change exists to move off emailed codes.
  function declinePasskey() {
    setPasskeyDeclined(true);
    try {
      sessionStorage.setItem(PASSKEY_DECLINED_THIS_SESSION_KEY, '1');
    } catch {
      // Private browsing can throw. Non-fatal: the worst case is the banner
      // appearing once, which is what happened before this existed.
    }
  }

  // THE PASSKEY CANNOT BE ENROLLED FROM THIS SCREEN, and that is not a bug in
  // the enrolment code — it is an ordering fact about the account.
  //
  // /api/passkey/register/options answers 401 "Not signed in" unless
  // getCurrentPlayer() finds a `players` row, and there is NO trigger on
  // auth.users that creates one: the row is written by completeOnboarding,
  // below. So on a brand-new account — the only kind that ever sees this
  // screen — there is no player to hang a credential on until the member
  // presses "Enter the club". Measured on production 2026-08-15: zero triggers
  // on auth.users, and 17 auth users with no players row.
  //
  // Enrolling here therefore always failed with a message about not being
  // signed in, shown to somebody visibly signed in and halfway through making
  // an account. It went unnoticed while the step was optional.
  //
  // So this button now records the ANSWER and handleComplete performs the
  // enrolment once the row exists. The member sees the same two choices in the
  // same place; only the moment of the WebAuthn prompt moves, from before the
  // account exists to immediately after.
  function choosePasskey() {
    setPasskeyWanted(true);
    setPasskeyDeclined(false);
  }

  const allAccepted = waiverAccepted && cocAccepted && termsAccepted && ageAttested;
  // Only the first name is required (profileSchema); mononyms are real names.
  const nameEntered = firstName.trim().length > 0;
  // Note the leading `tiers !== null && tiers.length > 0`: while the fetch is
  // in flight, and forever if it failed, there is nothing to answer and step 1
  // is gated on the name alone. The same shape as passkeyAnswered above, for
  // the same reason — an unanswerable question must never hold the door shut.
  const skillTierAnswered = !tiers || tiers.length === 0 || skillTier !== null;
  const step1Complete = nameEntered && skillTierAnswered;
  // What the last step prints in the STARTING ELO tile. The chosen tier's live
  // value, not a hardcoded 400 — that tile said "400" for every member
  // regardless of tier until 00127, which would have made the confirm screen
  // contradict the choice made two steps earlier.
  const startingElo = tiers?.find((t) => t.tier === skillTier)?.elo ?? null;

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
        passkey_setup: passkeyOutcome(),
        // Omitted rather than guessed when unanswered — the seed treats an
        // absent tier as "leave the rating alone", which is the club default.
        skill_tier: skillTier ?? undefined,
      });
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      // The row exists now, so the credential finally has something to hang
      // off. Failure here must not strand a member who has just completed
      // onboarding: they are in, and the feed's PasskeyNudge asks again.
      if (passkeyWanted) {
        setPasskeyBusy(true);
        const enrolled = await enrollPasskey();
        setPasskeyBusy(false);
        if (enrolled.ok) {
          await markPasskeyEnrolled();
          toast('Passkey saved — you can use it to sign in', 'success');
        } else if (enrolled.error) {
          toast(`${enrolled.error} You can add one later from Settings.`, 'error');
        }
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

            {/* The skill-level question. On step 1 rather than the confirm
                step because it is a fact about the member, like their name —
                and because the confirm step then has something true to show in
                its STARTING ELO tile. Rendered only when there is something to
                ask: an empty list means the settings read failed, and the
                member goes through on the club default. */}
            {tiers === null ? (
              <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <Loader2 size={14} className="animate-spin" /> Loading skill levels…
              </div>
            ) : tiers.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  className="mono muted"
                  style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}
                >
                  Skill level <span style={{ color: 'var(--red)' }}>*</span>
                </div>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 2 }}>
                  This sets where you start on the ladder. Your rating adjusts quickly over your
                  first few matches, so pick the closest fit — you do not need to get it exactly
                  right.
                </div>
                {tiers.map((option) => (
                  <TierChoice
                    key={option.tier}
                    option={option}
                    selected={skillTier === option.tier}
                    onSelect={setSkillTier}
                  />
                ))}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => { if (step1Complete) setStep(2); }}
              disabled={!step1Complete}
              className="btn btn-primary btn-lg"
              style={{
                width: '100%',
                justifyContent: 'center',
                height: 48,
                opacity: step1Complete ? 1 : 0.4,
              }}
            >
              Continue <ChevronRight size={14} />
            </button>
            {/* Say WHY it is disabled, the same as the last step's button. A
                dimmed control with no explanation is how somebody concludes the
                app is broken. Only ever names the thing actually missing. */}
            {!step1Complete && (
              <div className="muted" style={{ fontSize: 12, marginTop: -12, textAlign: 'center' }}>
                {!nameEntered ? 'Enter your first name to continue.' : 'Choose a skill level to continue.'}
              </div>
            )}
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
              {/* The tier chosen on step 1, at the club's live configured
                  value. This tile read a hardcoded 400 for every member until
                  00127 — with tiers that would have been the confirm screen
                  contradicting the answer given two steps earlier. An em dash
                  when no tier was asked for, rather than a number nobody
                  chose. */}
              <div className="card-base" style={{ textAlign: 'center', padding: 16 }}>
                <div className="stat-label">STARTING ELO</div>
                <div className="stat-value" style={{ marginTop: 4 }}>
                  {startingElo ?? '—'}
                </div>
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

            {/* The passkey question. Full width and above the fold of this
                step, not a footnote beside a "Set up" link, because it is now
                the thing standing between the member and the button below. */}
            {passkeyOffered && (
              <div
                className="card-base"
                style={{
                  padding: 16,
                  // Answered cards recede; the unanswered one is the only thing
                  // on this step wearing the accent, so what to do next is
                  // never in question.
                  borderColor: passkeyAnswered ? 'var(--line)' : 'var(--red)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <KeyRound size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {passkeyAdded ? 'Passkey ready' : 'Set up your passkey'}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.5 }}>
                      {passkeyAdded
                        ? 'Next time, sign in with your fingerprint, face or device PIN — this device will offer it automatically.'
                        : passkeyDeclined
                        ? "No problem — we'll email you a 6-digit code every time you sign in. You can add a passkey later from Settings."
                        : 'Sign in with your fingerprint, face or device PIN instead of waiting on an emailed code. It takes one tap and stays on this device.'}
                    </div>
                  </div>
                  {passkeyAdded && (
                    <span
                      className="mono"
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}
                    >
                      <Check size={14} /> Added
                    </span>
                  )}
                </div>

                {/* The chosen state. The button no longer enrols on the spot —
                    it cannot, there is no players row yet — so without this the
                    member taps "Set up a passkey", sees nothing happen, and taps
                    it again. This says the choice landed and when the prompt
                    comes. */}
                {passkeyWanted && !passkeyAdded && (
                  <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 14 }}>
                    <Check size={14} /> Your device will ask for it when you enter the club.
                  </div>
                )}

                {!passkeyAdded && !passkeyWanted && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={passkeyBusy}
                      onClick={choosePasskey}
                      style={{ width: '100%', justifyContent: 'center', height: 48, gap: 8 }}
                    >
                      {passkeyBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                      {passkeyDeclined ? 'Set up a passkey after all' : 'Set up a passkey'}
                    </button>
                    {/* The decline. A real button the member has to press, not a
                        pre-ticked box and not a way of doing nothing — that is
                        the entire difference between this and the old optional
                        offer, and it is what makes the recorded 'declined'
                        mean something. */}
                    {!passkeyDeclined && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={passkeyBusy}
                        onClick={declinePasskey}
                        style={{ width: '100%', justifyContent: 'center', height: 44, gap: 8 }}
                      >
                        <Mail size={14} />
                        No thanks — email me a code each time
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Nothing is ASKED of a member who cannot do this: they are told
                what will happen instead, once, and the button below stays live.
                They are still recorded — as 'unsupported' or 'unavailable', not
                as a refusal — because the whole point of that column is being
                able to tell "would not" from "could not". Covers both a browser
                without WebAuthn and a deployment that cannot enrol. */}
            {passkeyImpossible && (
              <div className="card-base" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <Mail size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    {passkeySupported === false
                      ? "This browser can't store a passkey, so we'll email you a 6-digit code each time you sign in."
                      : "Passkeys aren't available on this site yet, so we'll email you a 6-digit code each time you sign in."}
                  </div>
                </div>
              </div>
            )}

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

            <div>
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
                  disabled={loading || !passkeyAnswered}
                  className="btn btn-primary btn-lg"
                  style={{
                    flex: 1,
                    justifyContent: 'center',
                    height: 48,
                    opacity: passkeyAnswered ? 1 : 0.4,
                  }}
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={14} />}
                  Enter the club
                </button>
              </div>
              {/* Say WHY it is disabled. A dimmed button with no explanation is
                  how a member ends up stuck on the last step of onboarding
                  believing the app is broken. */}
              {!passkeyAnswered && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
                  Set up a passkey above, or choose to keep emailed codes, to continue.
                </div>
              )}
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
