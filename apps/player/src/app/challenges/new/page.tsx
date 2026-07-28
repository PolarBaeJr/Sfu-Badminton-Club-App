import { isUuid } from '@badminton/shared';
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
  return <NewChallengeClient initialOpponentId={isUuid(opponent) ? opponent : undefined} />;
}
