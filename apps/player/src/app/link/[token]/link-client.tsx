'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@badminton/ui';
import { clearHostOnlyAuthCookies } from '@badminton/shared';
import { Check } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { ConsentShell } from './consent-shell';
import { consumeDiscordLink, type LinkResult } from './actions';

// One granted permission. Left-aligned and marked, because a consent screen's
// job is to be scanned — a member deciding whether to press the button reads
// this list and nothing else.
function Grant({ children }: { children: React.ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <Check size={14} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 3 }} aria-hidden />
      <span style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--ink-2, var(--ink))' }}>
        {children}
      </span>
    </li>
  );
}

// The confirmation step, and it exists for a reason beyond politeness: the
// exchange has to happen on a POST. Discord fetches URLs it is shown in order
// to build previews, so a page that consumed the token on GET could be burned
// by a crawler before the member ever tapped it.
//
// NOTE ON WHAT THIS SCREEN MAY SHOW. It names the club account and never the
// Discord one, and that is not an oversight — 00165 stores only a hash of the
// token beside the Discord user id, and keeps expired, used and never-existed
// tokens indistinguishable so that a guesser cannot learn that a token string
// was real. Resolving the token to a Discord username here in order to render
// a friendlier "connect @someone" would hand that back: the page would answer,
// for any string typed into the address bar, whether it was ever a live token.
export function LinkClient({ token, playerName }: { token: string; playerName: string }) {
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(null);

  async function connect() {
    setPending(true);
    try {
      setResult(await consumeDiscordLink(token));
    } catch {
      setResult({ ok: false, message: 'Something went wrong. Run /link again in Discord.' });
    } finally {
      setPending(false);
    }
  }

  // The escape hatch for the wrong-account case, which used to be a paragraph
  // asking the member to go and sign out somewhere else. Returning to this same
  // URL is what makes it work: signed out, the page sends them to
  // /login?discord=<token> and the token survives sign-in, so they land back
  // here as the right person with the token unspent.
  async function switchAccount() {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // See clearHostOnlyAuthCookies: signOut alone can leave a pre-migration
      // host-only cookie behind, which would still read as a live session.
      clearHostOnlyAuthCookies();
    } finally {
      window.location.href = `/link/${token}`;
    }
  }

  if (result) {
    return (
      <ConsentShell
        eyebrow="DISCORD"
        title={result.ok ? 'Connected' : 'Not connected'}
      >
        <p className="page-sub" style={{ margin: 0 }}>{result.message}</p>
        <p className="page-sub" style={{ margin: 0 }}>
          {result.ok ? (
            'You can close this tab and go back to Discord — your roles are already set.'
          ) : (
            <>
              Run <code>/link</code> in Discord to get a new link.
            </>
          )}
        </p>
        <Link href="/feed" style={{ display: 'block' }}>
          <Button variant="secondary" className="w-full">Back to the app</Button>
        </Link>
      </ConsentShell>
    );
  }

  return (
    <ConsentShell eyebrow="DISCORD" title="Connect your account">
      <p className="page-sub" style={{ margin: 0 }}>
        The Discord account that ran <code>/link</code> is asking to connect to your club
        account. Connecting will:
      </p>

      <ul style={{ display: 'flex', flexDirection: 'column', gap: 9, margin: 0, padding: 0, listStyle: 'none' }}>
        <Grant>Give that Discord account the server roles your membership earns</Grant>
        <Grant>Keep them in step on their own — including taking them back if your membership ends</Grant>
        <Grant>Nothing travels the other way: your Discord roles never change your club account</Grant>
      </ul>

      {/* The account being connected, stated rather than assumed. This is the
          one fact a member can get wrong here, and it is worth a line of its
          own — signed in as the wrong person, the button quietly hands the
          roles to somebody else's Discord. */}
      <div
        style={{
          border: '1px solid var(--line)',
          background: 'var(--surface-2)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase' }}>
            Signed in as
          </div>
          <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2, overflowWrap: 'anywhere' }}>
            {playerName}
          </div>
        </div>
        <button
          type="button"
          onClick={switchAccount}
          disabled={signingOut || pending}
          className="mono"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: 11,
            color: 'var(--red)',
            textDecoration: 'underline',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {signingOut ? 'Signing out…' : 'Not you?'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Link href="/feed" style={{ flex: 1 }} tabIndex={-1}>
          <Button variant="secondary" className="w-full" disabled={pending}>Cancel</Button>
        </Link>
        <Button onClick={connect} loading={pending} className="w-full" style={{ flex: 1 }}>
          {pending ? 'Connecting' : 'Connect'}
        </Button>
      </div>

      <p className="mono muted" style={{ fontSize: 11, lineHeight: 1.5, margin: 0, textAlign: 'center' }}>
        Undo any time with <code>/unlink</code> in Discord.
      </p>
    </ConsentShell>
  );
}
