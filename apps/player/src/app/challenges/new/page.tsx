import { isUuid, getAccountStanding } from '@badminton/shared';
import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { getCurrentPlayer } from '@/lib/supabase-server';
import NewChallengeClient from './new-challenge-client';

// Server wrapper so ?opponent= can be read without useSearchParams(), which in
// a client component would need its own <Suspense> boundary to survive the
// production build (and the `dynamic` route-segment escape hatch is not
// available from a 'use client' file). Same page/client split as /leaderboard.
//
// The link at /leaderboard/[playerId] has always pointed here with ?opponent=,
// and the profile QR encodes the same URL — this is where it finally lands.
// A non-UUID is dropped: the value is only a UI hint, and every real check
// still happens in createChallenge -> validate_challenge_creation.
export default async function NewChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ opponent?: string }>;
}) {
  const { opponent } = await searchParams;

  // The one screen whose only purpose is an action the server would refuse, so
  // here "explain instead of hide" means replacing the form rather than
  // stripping buttons out of it: filling in a whole challenge and being told
  // no at submit is worse than being told now. Deep links from a QR code or a
  // stale notification land here too, which is why it is the page and not just
  // the entry points that has to say it.
  const standing = getAccountStanding(await getCurrentPlayer());
  if (!standing.ok) {
    return (
      <div data-screen-label="New Challenge">
        <PageHeader title="New Challenge" sub="Pick an opponent, a format, and send it." />
        <div className="card-base" style={{ padding: 24 }}>
          <h3 className="card-title">Challenges are paused</h3>
          <p className="card-sub" style={{ marginTop: 8, maxWidth: '60ch' }}>{standing.detail}</p>
          <div style={{ marginTop: 16 }}>
            <Link href="/leaderboard" className="btn btn-primary">Back to the ladder</Link>
          </div>
        </div>
      </div>
    );
  }

  return <NewChallengeClient initialOpponentId={isUuid(opponent) ? opponent : undefined} />;
}
