'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { SIGNIN_OTP_TYPES, friendlyAuthError, isUnknownAccountError } from '@badminton/shared';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { clearHostOnlyAuthCookies } from '@badminton/shared/src/utils/constants';
import { Mail, Loader2, KeyRound } from 'lucide-react';
import {
  signInWithPasskey,
  supportsPasskeys,
  beginConditionalPasskeySignIn,
  cancelPasskeyCeremony,
  PASSKEY_AUTOFILL_AUTOCOMPLETE,
} from '@/lib/passkey-client';
import {
  authSuffix,
  clearLoginIntentCookieString,
  loginIntentCookieString,
  parseAuthError,
} from '@/lib/auth-intent';
import { sendEmailCode, verifyEmailCode } from '@/lib/email-code-client';
import { AuthCard } from '@/components/auth/auth-card';
import { CodeStep } from '@/components/auth/code-step';
import { GoogleIcon } from '@/components/auth/google-icon';

// Sign in only. Creating an account lives on /signup, and nothing on this page
// can create one: the email code is sent with shouldCreateUser: false, Google
// carries a sign-in intent cookie the callback enforces, and a code that
// verifies for an auth user with no player row is signed straight back out.
//
// The check-in and Discord tokens are read from window.location instead of
// useSearchParams(): in the Next 14 App Router the hook fails the production
// build unless the whole page is wrapped in <Suspense>. Read only inside
// effects and handlers, so the server HTML and the first client render match.
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [noAccount, setNoAccount] = useState<'unknown' | 'unfinished' | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [seasonName, setSeasonName] = useState('');
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // Resolved in an effect, never during render: browserSupportsWebAuthn()
  // touches window, so deciding this inline would mismatch the server HTML.
  const [canUsePasskeys, setCanUsePasskeys] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [authFailed, setAuthFailed] = useState(false);

  useEffect(() => {
    setCanUsePasskeys(supportsPasskeys());
    setSuffix(authSuffix(window.location.search));
    setAuthFailed(parseAuthError(new URLSearchParams(window.location.search).get('error')) !== null);
  }, []);

  // Passkey autofill. The member presses nothing: if this browser supports
  // conditional mediation and they have a credential for this site, it appears
  // in the email field's own dropdown and picking it signs them in.
  //
  // Deliberately NOT gated on canUsePasskeys: beginConditionalPasskeySignIn
  // does its own (stricter) detection and returns false without touching the
  // network when the browser cannot do this, so gating here would only add a
  // render's delay and a second source of truth.
  //
  // Runs only on the screen that actually has the email field: the code screen
  // (`sent`) has unmounted it. Leaving that state runs the cleanup, which
  // cancels the pending ceremony so it can never complete against a challenge
  // cookie some later request has replaced.
  useEffect(() => {
    if (sent) return;
    let live = true;
    void beginConditionalPasskeySignIn().then((signedIn) => {
      if (signedIn && live) window.location.href = `/auth/post-login${authSuffix(window.location.search)}`;
    });
    return () => {
      live = false;
      cancelPasskeyCeremony();
    };
  }, [sent]);

  async function handlePasskeyLogin() {
    setPasskeyLoading(true);
    setError('');
    const result = await signInWithPasskey();
    if (result.ok) {
      window.location.href = `/auth/post-login${authSuffix(window.location.search)}`;
      return;
    }
    // An empty message means the user dismissed the system prompt. That is a
    // deliberate action, not a failure to report back at them.
    if (result.error) setError(result.error);
    setPasskeyLoading(false);
  }

  // The login page is logged-out, so it can't read the seasons table under RLS.
  // The anon-safe get_active_season() RPC surfaces just the season name.
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

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setError('');
    const secure = window.location.protocol === 'https:';
    // Tells /auth/callback this round trip is a sign-in, so a Google account
    // with no player behind it is sent to /signup instead of being enrolled.
    document.cookie = loginIntentCookieString(secure);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback${authSuffix(window.location.search)}` },
    });
    if (authError) {
      document.cookie = clearLoginIntentCookieString(secure);
      setError(friendlyAuthError(authError.message));
      setGoogleLoading(false);
    }
  }

  async function sendCode() {
    const { error: sendError } = await sendEmailCode(email, { createUser: false });
    if (sendError && isUnknownAccountError(sendError)) {
      setNoAccount('unknown');
      setError('');
      return false;
    }
    if (sendError) {
      setError(friendlyAuthError(sendError.message));
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
    const result = await verifyEmailCode(email, code.trim(), SIGNIN_OTP_TYPES);
    if (!result.ok) {
      setError(friendlyAuthError(result.message));
      setLoading(false);
      return;
    }
    // An auth user with no player row never finished signing up (an account
    // from before first sign-in created the row). Checked here, not in
    // /auth/post-login: that is a Server Component and cannot clear cookies.
    // players_self is scoped to auth.uid(), so null data with no error means no
    // row. A read error fails OPEN, the same stance as the middleware's gate.
    const supabase = createClient();
    const { data, error: readError } = await supabase.from('players_self').select('id').maybeSingle();
    if (!readError && !data) {
      await supabase.auth.signOut();
      // See clearHostOnlyAuthCookies: signOut alone can leave a pre-migration
      // host-only cookie behind, which would still read as a live session.
      clearHostOnlyAuthCookies();
      setSent(false);
      setCode('');
      setNoAccount('unfinished');
      setLoading(false);
      return;
    }
    window.location.href = `/auth/post-login${authSuffix(window.location.search)}`;
  }

  // Hands the typed address to /signup through this tab's sessionStorage, so
  // it never appears in a URL or reaches a server log.
  function goToSignup() {
    try {
      sessionStorage.setItem('signup_prefill_email', email);
    } catch {
      // Storage unavailable: /signup just starts empty.
    }
  }

  return (
    <AuthCard subtitle={seasonName || 'Player sign in'}>
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
          submitLabel="Sign in"
          sentNotice={sentNotice}
        />
      ) : (
        <>
          <div className="signin-heading">
            <div className="page-eyebrow"><span className="bar" /> WELCOME BACK</div>
            <h2>Sign in</h2>
            <div className="page-sub" style={{ marginTop: 6, marginInline: 'auto' }}>
              Use a passkey, Google, or a 6-digit code we email you.
            </div>
          </div>

          {authFailed && (
            <div className="alert-danger" role="alert">That sign-in did not go through. Please try again.</div>
          )}

          {noAccount && (
            <div className="signin-notice" role="alert">
              {noAccount === 'unknown'
                ? 'No account uses that email.'
                : 'That email has not finished signing up yet.'}{' '}
              <Link href={`/signup${suffix}`} onClick={goToSignup}>Create an account</Link>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {canUsePasskeys && (
              <button
                type="button"
                onClick={handlePasskeyLogin}
                disabled={passkeyLoading}
                className="btn btn-ghost btn-lg signin-alt"
              >
                {passkeyLoading ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
                Sign in with a passkey
              </button>
            )}
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={googleLoading}
              className="btn btn-ghost btn-lg signin-alt"
            >
              {googleLoading ? <Loader2 size={18} className="animate-spin" /> : <GoogleIcon />}
              Continue with Google
            </button>
          </div>

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
              {/* The `webauthn` token is what makes this field an autofill
                  surface for a passkey. Without it the conditional request
                  above refuses to start. See PASSKEY_AUTOFILL_AUTOCOMPLETE. */}
              <input
                id="email"
                type="email"
                autoComplete={PASSKEY_AUTOFILL_AUTOCOMPLETE}
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
            New to the club? <Link href={`/signup${suffix}`}>Create an account</Link>
          </div>
        </>
      )}
      <div className="signin-legal">
        By signing in you agree to the <Link href="/legal/terms">Terms of Use</Link> and{' '}
        <Link href="/legal/privacy">Privacy Policy</Link>.
      </div>
    </AuthCard>
  );
}
