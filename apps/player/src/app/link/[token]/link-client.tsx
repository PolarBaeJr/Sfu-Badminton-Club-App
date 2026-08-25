'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@badminton/ui';
import { consumeDiscordLink, type LinkResult } from './actions';

// The confirmation step, and it exists for a reason beyond politeness: the
// exchange has to happen on a POST. Discord fetches URLs it is shown in order
// to build previews, so a page that consumed the token on GET could be burned
// by a crawler before the member ever tapped it.
export function LinkClient({ token, playerName }: { token: string; playerName: string }) {
  const [pending, setPending] = useState(false);
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

  if (result) {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 700 }}>
          {result.ok ? 'Connected' : "Couldn't connect"}
        </h1>
        <p className="page-sub" style={{ marginTop: 8 }}>{result.message}</p>
        <p className="page-sub" style={{ marginTop: 24 }}>
          {result.ok ? (
            'You can close this tab and go back to Discord.'
          ) : (
            <>
              Run <code>/link</code> in Discord to get a new link.
            </>
          )}
        </p>
        <div style={{ marginTop: 24 }}>
          <Link href="/feed">
            <Button variant="secondary">Back to the app</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-16 px-4 text-center">
      <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 700 }}>
        Connect Discord
      </h1>
      <p className="page-sub" style={{ marginTop: 8 }}>
        This connects the Discord account that ran <code>/link</code> to {playerName}. Your
        Discord roles are set from your club account, and update on their own from then on.
      </p>
      <p className="page-sub" style={{ marginTop: 16 }}>
        If you were signed in as someone else, sign out first — whoever is signed in here is
        the account that gets connected.
      </p>
      <div style={{ marginTop: 28 }}>
        <Button onClick={connect} disabled={pending}>
          {pending ? 'Connecting…' : 'Connect my account'}
        </Button>
      </div>
    </div>
  );
}
