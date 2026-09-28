'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import {
  SIGNIN_OTP_TYPES,
  authErrorCode,
  friendlyAuthError,
  isUnknownAccountError,
  withErrorCode,
} from '@badminton/shared';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { signOutOtherDevices, signOutThisDevice } from '@badminton/shared/src/utils/sign-out';
import { Mail, Loader2 } from 'lucide-react';
import { authSuffix } from '@/lib/auth-intent';
import { sendEmailCode, verifyEmailCode } from '@/lib/email-code-client';
import { usePasswordSave } from '@/lib/use-password-save';
import { AuthCard } from '@/components/auth/auth-card';
import { CodeStep } from '@/components/auth/code-step';
import { SetPasswordStep } from '@/components/auth/set-password-step';

// Forgot password: an emailed code signs the member in, then they choose a new
// password. No resetPasswordForEmail: sendEmailCode already issues a
// `recovery` token to an existing member and recognises an unknown address.
// Sent with shouldCreateUser: false, so nothing here can create an account.
export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'email' | 'code' | 'password'>('email');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [noAccount, setNoAccount] = useState<'unknown' | 'unfinished' | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [suffix, setSuffix] = useState('');
  const pw = usePasswordSave({
    onSaved: async () => {
      // A reset is often a reaction to someone else getting in, so end every
      // other session. Best effort: the password is already changed either way.
      await signOutOtherDevices(createClient().auth).catch(() => undefined);
      window.location.href = `/auth/post-login${authSuffix(window.location.search)}`;
    },
  });

  useEffect(() => {
    setSuffix(authSuffix(window.location.search));
    // Read once and removed at once, the same hand-off /signup uses.
    try {
      const prefill = sessionStorage.getItem('forgot_prefill_email');
      if (prefill) setEmail(prefill);
      sessionStorage.removeItem('forgot_prefill_email');
    } catch {
      // Storage unavailable: start empty.
    }
  }, []);

  async function sendCode() {
    const { error: sendError } = await sendEmailCode(email, { createUser: false });
    if (sendError && isUnknownAccountError(sendError)) {
      setNoAccount('unknown');
      setError('');
      return false;
    }
    if (sendError) {
      setError(withErrorCode(friendlyAuthError(sendError.message), authErrorCode(sendError)));
      return false;
    }
    setCode('');
    return true;
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setNoAccount(null);
    setSentNotice(null);
    if (await sendCode()) setStep('code');
    setLoading(false);
  }

  async function handleResend() {
    setResending(true);
    setError('');
    setSentNotice(null);
    if (await sendCode()) setSentNotice('A new code is on its way.');
    setResending(false);
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await verifyEmailCode(email, code.trim(), SIGNIN_OTP_TYPES);
    if (!result.ok) {
      setError(withErrorCode(friendlyAuthError(result.message), authErrorCode(result)));
      setLoading(false);
      return;
    }
    // The same no-player-row check as /login: an account that never finished
    // signing up is signed straight back out, not handed a password.
    const supabase = createClient();
    const { data, error: readError } = await supabase.from('players_self').select('id').maybeSingle();
    if (!readError && !data) {
      await signOutThisDevice(supabase.auth);
      setStep('email');
      setCode('');
      setNoAccount('unfinished');
      setLoading(false);
      return;
    }
    setStep('password');
    setLoading(false);
  }

  return (
    <AuthCard subtitle="Reset your password">
      {step === 'password' && pw.step === 'code' ? (
        <CodeStep
          email={email}
          title="Confirm it is you"
          lead={<>We emailed a 6-digit code to <strong>{email}</strong> to confirm your new password.</>}
          codeLabel="Confirmation code"
          code={pw.nonce}
          onCodeChange={pw.setNonce}
          onSubmit={(e) => { e.preventDefault(); void pw.submitCode(); }}
          onResend={() => void pw.resendCode()}
          onChangeEmail={pw.cancel}
          altLabel="Choose a different password"
          loading={pw.busy}
          resending={pw.busy}
          error={pw.error}
          submitLabel="Save password"
          sentNotice={pw.notice || null}
        />
      ) : step === 'password' ? (
        <SetPasswordStep
          onSubmit={(next) => void pw.submitPassword(next)}
          loading={pw.busy}
          error={pw.error}
          submitLabel="Save password"
          lead="You are signed in. Choose a new password; saving it signs you out on every other device."
        />
      ) : step === 'code' ? (
        <CodeStep
          email={email}
          code={code}
          onCodeChange={setCode}
          onSubmit={handleVerifyCode}
          onResend={handleResend}
          onChangeEmail={() => { setStep('email'); setCode(''); setError(''); setSentNotice(null); }}
          loading={loading}
          resending={resending}
          error={error}
          submitLabel="Continue"
          sentNotice={sentNotice}
        />
      ) : (
        <>
          <div className="signin-heading">
            <div className="page-eyebrow"><span className="bar" /> FORGOT PASSWORD</div>
            <h2>Reset your password</h2>
            <div className="page-sub" style={{ marginTop: 6, marginInline: 'auto' }}>
              We will email you a 6-digit code. Enter it, then choose a new password.
            </div>
          </div>

          {noAccount && (
            <div className="signin-notice" role="alert">
              {noAccount === 'unknown'
                ? 'No account uses that email.'
                : 'That email has not finished signing up yet.'}{' '}
              <Link href={`/signup${suffix}`}>Create an account</Link>
            </div>
          )}

          <form onSubmit={handleSendCode} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label htmlFor="email" className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              Email
            </label>
            <div style={{ position: 'relative' }}>
              <Mail
                size={16}
                className="text-[var(--mute)]"
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setNoAccount(null); }}
                placeholder="you@sfu.ca"
                required
                className="input-base"
                style={{ paddingLeft: 38 }}
              />
            </div>
            {error && <div className="alert-danger" role="alert">{error}</div>}
            <button type="submit" disabled={loading} className="btn btn-primary btn-lg signin-cta">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={14} />}
              Email me a code
            </button>
          </form>

          <div className="signin-switch">
            Remembered it? <Link href={`/login${suffix}`}>Sign in</Link>
          </div>
        </>
      )}
    </AuthCard>
  );
}
