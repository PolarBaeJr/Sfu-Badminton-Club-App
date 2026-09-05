import { redirect } from 'next/navigation';
import { DISCORD_LINK_TOKEN_REGEX, getAccountStanding } from '@badminton/shared';
import { getViewer } from '@/lib/supabase-server';
import { LinkClient } from './link-client';
import { ConsentShell } from './consent-shell';

// Consumes a single-use token against whoever is signed in. Never cached.
export const dynamic = 'force-dynamic';

// Landing page for the button in Discord's /link reply.
//
// The token identifies the DISCORD ACCOUNT only; the club member is whoever is
// signed in on this browser. That split is the whole security model — the bot
// never learns a password and never becomes an identity provider, and the two
// halves are proven independently.
export default async function LinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Shape-checked before anything else uses it, including the redirect below.
  if (!DISCORD_LINK_TOKEN_REGEX.test(token)) {
    return (
      <Shell eyebrow="DISCORD" title="That link isn&apos;t valid">
        Run <code>/link</code> in Discord to get a new one.
      </Shell>
    );
  }

  const { player } = await getViewer();
  if (!player) {
    // Middleware already carries the token through sign-in; this is the second
    // line of defence for anyone who reaches the page without a session
    // anyway. Only a well-formed token travels, so nothing arbitrary can ride
    // along and this cannot become an open redirect.
    redirect(`/login?discord=${token}`);
  }

  // A banned or removed member must not pick up club roles in Discord — that
  // is the same access the ban withdrew, wearing a different hat. Said on
  // arrival rather than after they press the button.
  const standing = getAccountStanding(player);
  if (!standing.ok) {
    return (
      <Shell eyebrow="DISCORD" title="Can&apos;t connect your account">
        {standing.detail}
      </Shell>
    );
  }

  return <LinkClient token={token} playerName={player.first_name ?? 'your account'} />;
}

// The refusals wear the same card as the grant itself — same width, same marks,
// same rhythm. A member who is turned away should be able to see they reached
// the right page and were told no, not wonder whether the link was broken.
function Shell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <ConsentShell eyebrow={eyebrow} title={title}>
      <p className="page-sub" style={{ margin: 0 }}>{children}</p>
    </ConsentShell>
  );
}
