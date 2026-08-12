'use client';

import { useState } from 'react';
import { setRoundMatchShape } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { describeMatchShape, resolveMatchShape, isPlayedMatch } from '@badminton/shared';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

// ============================================================
// What one round is played to, set from the round's own heading (00108)
// ============================================================
//
// "we play round robin 11s then play single elim first round 11s, quarter 15s
// semis 21s finals and third place games best to 3 21s".
//
// IT LIVES ON THE ROUND HEADING because that is where the exec is already
// looking when they think about a round — "the quarter-finals" is a heading on
// this page, and putting the control in Event Settings would mean naming rounds
// in a dialog that cannot see the draw. It is also the only place the CURRENT
// answer can be shown next to the thing it describes.
//
// A CLOSED SELECT, NOT TWO NUMBER FIELDS. Every shape the club plays is one of
// these four, they are the four the event-level enum already offers, and a free
// pair of numbers on a per-round control multiplies the ways a draw can end up
// with a round nobody meant. "Same as the event" is first, and it is what a
// round with no override reads as — so an exec can always get back to the
// unmodified behaviour without knowing what the event's shape is.

const CHOICES: Array<{ id: string; label: string; games: number | null; points: number | null }> = [
  { id: 'inherit', label: 'Same as the event', games: null, points: null },
  { id: '11', label: '1 game to 11', games: 1, points: 11 },
  { id: '15', label: '1 game to 15', games: 1, points: 15 },
  { id: '21', label: '1 game to 21', games: 1, points: 21 },
  { id: 'bo3', label: 'Best of 3 to 21', games: 3, points: 21 },
];

function choiceIdFor(match: TournamentMatchRow | undefined): string {
  if (!match) return 'inherit';
  const g = match.games_per_match ?? null;
  const p = match.points_per_game ?? null;
  if (g == null && p == null) return 'inherit';
  const hit = CHOICES.find((c) => c.games === g && c.points === p);
  // A shape somebody set through another route — an older draw, a hand-written
  // row — is shown as 'custom' rather than silently snapped to the nearest
  // preset, which would make the select lie about what is being played.
  return hit ? hit.id : 'custom';
}

interface Props {
  event: TournamentEventRow;
  /** Every match in this round, including byes. */
  matches: TournamentMatchRow[];
  /** null on a single-phase event, where the matches carry phase NULL. */
  phase: 'pool' | 'bracket' | null;
  /** The round's number, or null for the third-place playoff. */
  roundNumber: number | null;
  thirdPlace?: boolean;
}

export function RoundShapeControl({ event, matches, phase, roundNumber, thirdPlace = false }: Props) {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const first = matches[0];
  const selected = choiceIdFor(first);
  // Resolved, not raw: an inheriting round has to show what it is ACTUALLY
  // played to, which is the event's shape, or the label would read "Same as the
  // event" next to nothing and say less than the page said before this control
  // existed.
  const resolved = describeMatchShape(resolveMatchShape(first ?? null, event));
  // The EVENT's own shape, which is a different string the moment this round
  // overrides it — "Same as the event (Best of 3 to 21)" must name what the
  // event says, not what this round currently says.
  const eventShape = describeMatchShape(event);

  // A ROUND WITH A RESULT IS NOT EDITABLE, and it says so rather than failing on
  // click. The server refuses on the same definition (isPlayedMatch, so byes do
  // not count), which is what keeps the two in step.
  const played = matches.filter(isPlayedMatch).length;
  const finalised = event.status === 'completed';
  const locked = played > 0 || finalised;

  async function change(choiceId: string) {
    const choice = CHOICES.find((c) => c.id === choiceId);
    if (!choice) return;
    setSaving(true);
    const res = await setRoundMatchShape(
      event.id as string,
      { phase, roundNumber, thirdPlace },
      choice.games == null || choice.points == null
        ? null
        : { games_per_match: choice.games, points_per_game: choice.points },
    );
    if (!res.ok) { toast(res.error, 'error'); setSaving(false); return; }
    toast(choice.id === 'inherit' ? 'Round follows the event again' : `Round set to ${choice.label}`, 'success');
    router.refresh();
    setSaving(false);
  }

  const label = thirdPlace
    ? 'What the third-place playoff is played to'
    : `What round ${roundNumber} is played to`;

  if (locked) {
    return (
      <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
        {resolved}
      </span>
    );
  }

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">{label}</span>
      <select
        value={selected}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        aria-label={label}
        className="text-[11px] rounded-[6px] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-primary)] px-2 py-1 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
      >
        {selected === 'custom' && <option value="custom">{resolved}</option>}
        {CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id === 'inherit' ? `Same as the event (${eventShape})` : c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
