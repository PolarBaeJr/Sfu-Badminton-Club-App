import { TournamentCheckInClient } from './checkin-client';

// Check-in depends on who is signed in and mutates their entries, so it must
// never be cached or prerendered.
export const dynamic = 'force-dynamic';

// Landing page for the tournament check-in QR an exec displays at the door.
//
// Reached two ways, both supported on purpose:
//   * the phone's native camera app, which opens this URL with ?token=… and
//     checks in immediately;
//   * the in-app scanner, for someone already in the app who taps "Scan".
//
// The token identifies the TOURNAMENT only. Which events a scan checks into is
// decided server-side from that player's own entries — the code carries no
// authority over anyone else.
export default async function TournamentCheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div data-screen-label="Tournament check-in">
      <div className="page-eyebrow" style={{ marginBottom: 4 }}>
        <span className="bar" /> CHECK IN
      </div>
      <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 700, margin: '0 0 16px' }}>
        Tournament check-in
      </h1>
      <TournamentCheckInClient initialToken={token} />
    </div>
  );
}
