'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { SIGNUP_OTP_TYPES, authErrorCode, friendlyAuthError, withErrorCode } from '@badminton/shared';
import { Mail, Loader2 } from 'lucide-react';
import { authSuffix, clearLoginIntentCookieString, parseSignupNotice } from '@/lib/auth-intent';
import { sendEmailCode, verifyEmailCode } from '@/lib/email-code-client';
import { AuthCard } from '@/components/auth/auth-card';
import { CodeStep } from '@/components/auth/code-step';
import { GoogleIcon } from '@/components/auth/google-icon';

// Create an account. No passkey button: a passkey proves an account that
// already exists, so it is the one route that cannot work here. After a code
// verifies, /auth/post-login creates or claims the player row and the
// middleware sends the new member on to onboarding.
//
// Reads window.location and sessionStorage only inside effects and handlers,
// for the same reasons as /login.
export function SignupForm({ guestWaiversOn }: { guestWaiversOn: boolean }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [seasonName, setSeasonName] = useState('');
  const [suffix, setSuffix] = useState('');
  const [notice, setNotice] = useState<'no-account' | null>(null);

  useEffect(() => {
    // No `extra`: the notice is never carried back to /login.
    setSuffix(authSuffix(window.location.search));
    setNotice(parseSignupNotice(new URLSearchParams(window.location.search).get('notice')));
    // Read once and removed at once: /login's "Create an account" link leaves
    // the typed address here so it never appears in a URL.
    try {
      const prefill = sessionStorage.getItem('signup_prefill_email');
      if (prefill) setEmail(prefill);
      sessionStorage.removeItem('signup_prefill_email');
    } catch {
      // Storage unavailable: start empty.
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.rpc('get_active_season');
        setSeasonName(data?.[0]?.name ?? '');
      } catch {
        // No active season, or offline: fall back to the generic subtitle.
      }
    })();
  }, []);

  async function handleGoogleSignup() {
    setGoogleLoading(true);
    setError('');
    // Cleared first, so a sign-in intent left by an abandoned Google attempt on
    // /login cannot make the callback reject this genuine signup.
    document.cookie = clearLoginIntentCookieString(window.location.protocol === 'https:');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback${authSuffix(window.location.search)}` },
    });
    if (authError) {
      setError(withErrorCode(friendlyAuthError(authError.message), 'AUTH-209'));
      setGoogleLoading(false);
    }
  }

  async function sendCode() {
    const { error: sendError } = await sendEmailCode(email, { createUser: true });
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
    setSentNotice(null);
    if (await sendCode()) setSent(true);
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
    const result = await verifyEmailCode(email, code.trim(), SIGNUP_OTP_TYPES);
    if (!result.ok) {
      setError(withErrorCode(friendlyAuthError(result.message), authErrorCode(result)));
      setLoading(false);
      return;
    }
    window.location.href = `/auth/post-login${authSuffix(window.location.search)}`;
  }

  return (
    <AuthCard subtitle={seasonName || 'Join the club'}>
      {sent ? (
        <CodeStep
          email={email}
          code={code}
          onCodeChange={setCode}
          onSubmit={handleVerifyCode}
          onResend={handleResend}
          onChangeEmail={() => { setSent(false); setCode(''); setError(''); setSentNotice(null); }}
          loading={loading}
          resending={resending}
          error={error}
          submitLabel="Create account"
          sentNotice={sentNotice}
        />
      ) : (
        <>
          <div className="signin-heading">
            <div className="page-eyebrow"><span className="bar" /> NEW PLAYER</div>
            <h2>Create your account</h2>
            <div className="page-sub" style={{ marginTop: 6, marginInline: 'auto' }}>
              Join the club roster. Sign up with Google or your email, then set up your profile.
            </div>
          </div>

          {notice === 'no-account' && (
            <div className="signin-notice" role="status">
              We could not find an account for that sign-in. Create one below; it only takes a minute.
            </div>
          )}

          <button
            type="button"
            onClick={handleGoogleSignup}
            disabled={googleLoading}
            className="btn btn-ghost btn-lg signin-alt"
          >
            {googleLoading ? <Loader2 size={18} className="animate-spin" /> : <GoogleIcon />}
            Sign up with Google
          </button>

          <div className="hr-label">or with email</div>

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
                onChange={(e) => setEmail(e.target.value)}
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
            Already a member? <Link href={`/login${suffix}`}>Sign in</Link>
          </div>
          {guestWaiversOn && (
            <div className="signin-switch">
              Not a member? <Link href="/guest-waiver">Sign the guest waiver</Link>
            </div>
          )}
        </>
      )}
      <div className="signin-legal">
        By creating an account you agree to the <Link href="/legal/terms">Terms of Use</Link> and{' '}
        <Link href="/legal/privacy">Privacy Policy</Link>.
      </div>
    </AuthCard>
  );
}
