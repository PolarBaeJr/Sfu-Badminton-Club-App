/**
 * Who is allowed to open a challenge.
 *
 * FIX-LIST #14 / the member-privacy audit §2.6. `challenges_select` is
 * `USING (TRUE)` and `cp_select` is `USING (TRUE)` (00005_rls.sql:125,144),
 * and `challenges.note` — the free-text line one member writes at another when
 * they issue the challenge — is granted to `authenticated` along with the rest
 * of the row. `/challenges/[id]` read the row by id and rendered it, with no
 * check that the person reading is in the match. Any signed-in member who had
 * a challenge id could read somebody else's note, and
 * `GET /rest/v1/challenges?select=*,challenge_participants(*)` needed no id at
 * all: it returns who challenged whom, when, and every note in the club.
 *
 * THE LIST PAGE WAS ALREADY CORRECT — `/challenges` scopes with
 * `.eq('player_id', player.id)` on `challenge_participants` — which is why this
 * survived: the screen a member actually navigates to shows only their own, and
 * the hole is on the detail route they arrive at from a notification link.
 *
 * THE CREATOR IS A SEPARATE DISJUNCT ON PURPOSE, not a redundancy.
 * createChallenge inserts the `challenges` row FIRST and the participant rows
 * in a second statement on the service role (actions/challenges.ts:52-100),
 * so there is a window — and, if the second insert ever fails, a permanent
 * state — in which a challenge has a creator and no participants at all. The
 * creator being able to open their own orphaned challenge is what lets them
 * cancel it. It also matters to the RLS half (00156): the `.insert().select()`
 * there reads the row back through the SELECT policy at a moment when no
 * participant row exists yet, so a participants-only policy would make every
 * challenge creation fail with "no rows returned".
 *
 * This is the app half and it ships first. 00156 narrows the two policies to
 * the same rule so PostgREST refuses the bulk read as well; the app gate is
 * what closes the detail route in the window before that migration is applied
 * by hand, and stays afterwards as the thing that turns an invisible row into
 * a 404 rather than a render of `undefined`.
 */

/** The embedded shape PostgREST returns: to-many is an array, to-one can be
 *  either, and a failed embed is null. Only `player_id` is required of it. */
type EmbeddedParticipant = { player_id?: string | null } | null | undefined;

export interface ChallengeVisibilityRow {
  created_by?: string | null;
  challenge_participants?: EmbeddedParticipant[] | EmbeddedParticipant | null;
}

export function viewerMaySeeChallenge(
  challenge: ChallengeVisibilityRow | null | undefined,
  viewerId: string | null | undefined,
): boolean {
  if (!challenge || !viewerId) return false;
  if (challenge.created_by === viewerId) return true;

  const raw = challenge.challenge_participants;
  const participants = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return participants.some((cp) => cp?.player_id === viewerId);
}
