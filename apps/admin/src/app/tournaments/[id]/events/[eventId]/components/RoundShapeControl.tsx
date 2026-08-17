'use client';

import { useState } from 'react';
import { setRoundMatchShape } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import {
  describeMatchShape,
  resolveMatchShape,
  isPlayedMatch,
  eloWeightBreakdown,
  getEventRules,
  CUSTOM_FORMAT_BOUNDS,
  isLegalCustomGames,
  isLegalCustomPoints,
  customFormatHint,
} from '@badminton/shared';
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
// SIX PRESETS PLUS CUSTOM, not the original four. The four were "every shape the
// club plays", which was true of the event-level enum and never true of a round:
// the ladder exists precisely because a round is played to something the event
// is not. A best-of-3 to 15 has no preset to pick and no reason to be refused —
// tournament_matches carries the pair, derivedFormatWeight() takes arbitrary
// values, and setRoundMatchShape already validates against CUSTOM_FORMAT_BOUNDS
// (odd 1-7 games, 5-30 points) because the CHECK in 00108 enforces exactly that.
// So this is a UI gap being closed, not a capability being added: the custom
// route follows the idiom the EVENT-level control already uses (a `__custom__`
// sentinel that reveals two bounded number fields), rather than inventing a
// second one.

/** The UI-only sentinel for "type the numbers". Never stored, never sent. */
const CUSTOM = '__custom__';

// Ordered shortest to longest, which is the order a ladder climbs. The labels
// are DERIVED from describeMatchShape rather than typed out, so a preset and the
// resolved-shape text elsewhere on the page cannot disagree about casing —
// describeMatchShape says "1 Game to 15", and a hand-written "1 game to 15"
// beside it read as a different setting.
const PRESETS: Array<{ id: string; games: number; points: number }> = [
  { id: '11', games: 1, points: 11 },
  { id: '15', games: 1, points: 15 },
  { id: '21', games: 1, points: 21 },
  { id: 'bo3-11', games: 3, points: 11 },
  { id: 'bo3-15', games: 3, points: 15 },
  { id: 'bo3-21', games: 3, points: 21 },
];

function shapeLabel(games: number, points: number): string {
  // match_format is required by the type and is never consulted when both
  // numbers are present — getEventRules takes the pair over the enum.
  return describeMatchShape({
    match_format: 'best_of_3_to_21',
    games_per_match: games,
    points_per_game: points,
  });
}

function choiceIdFor(match: TournamentMatchRow | undefined): string {
  if (!match) return 'inherit';
  const g = match.games_per_match ?? null;
  const p = match.points_per_game ?? null;
  if (g == null && p == null) return 'inherit';
  const hit = PRESETS.find((c) => c.games === g && c.points === p);
  // A shape somebody set through another route — an older draw, a hand-written
  // row — opens on the custom fields rather than being silently snapped to the
  // nearest preset, which would make the select lie about what is being played.
  return hit ? hit.id : CUSTOM;
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
  /**
   * 'inline' stacks the control over its own Elo line, for a round heading that
   * stands on its own (RoundRobinTab). 'control' renders only the control,
   * because the caller — RoundLadder — gives the weight a column of its own and
   * two copies of the same figure in one row is the repetition being removed.
   */
  variant?: 'inline' | 'control';
}

export function RoundShapeControl({
  event,
  matches,
  phase,
  roundNumber,
  thirdPlace = false,
  variant = 'inline',
}: Props) {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const first = matches[0];
  const selected = choiceIdFor(first);
  // Resolved, not raw: an inheriting round has to show what it is ACTUALLY
  // played to, which is the event's shape, or the label would read "Same as the
  // event" next to nothing and say less than the page said before this control
  // existed.
  const shape = resolveMatchShape(first ?? null, event);
  const resolved = describeMatchShape(shape);
  // The EVENT's own shape, which is a different string the moment this round
  // overrides it — "Same as event (Best of 3 to 21)" must name what the event
  // says, not what this round currently says.
  const eventShape = describeMatchShape(event);
  const rules = getEventRules(shape);

  // WHAT THIS ROUND IS WORTH TO A RATING, under the shape shown above it.
  //
  // "the elo settings below the game" — and it belongs per ROUND rather than per
  // event because 00108 lets one draw rate its rounds four different ways: an
  // event-level figure would be right for at most one of them. The weight is
  // read out of the engine (resolvedFormatWeight), so it cannot disagree with
  // what rateTournamentMatch will apply, including on the branch where an
  // INHERITING round is weighed from the enum table rather than the formula.
  const elo = eloWeightBreakdown(shape, event.elo_multiplier);

  // TYPED, NOT YET SAVED. null means the custom fields are closed; a draft is
  // seeded from the shape on screen so an exec who picks Custom is ADJUSTING
  // what they were looking at rather than retyping it, exactly as the
  // event-level control does.
  //
  // A DRAFT RATHER THAN A WRITE PER KEYSTROKE. The select saves on change
  // because a select's change IS the decision, but two number fields wired the
  // same way would send points_per_game: 1 on the way to typing 15 — a value
  // the server correctly refuses at minPoints, so an exec would eat a rejection
  // toast per digit. Nothing is sent until Apply, and Apply only exists while
  // the pair is legal.
  const [draft, setDraft] = useState<{ games: string; points: string } | null>(null);

  // A ROUND WITH A RESULT IS NOT EDITABLE, and it says so rather than failing on
  // click. The server refuses on the same definition (isPlayedMatch, so byes do
  // not count), which is what keeps the two in step.
  const played = matches.filter(isPlayedMatch).length;
  const finalised = event.status === 'completed';
  const locked = played > 0 || finalised;

  async function save(
    payload: { games_per_match: number; points_per_game: number } | null,
    said: string,
  ) {
    setSaving(true);
    const res = await setRoundMatchShape(
      event.id as string,
      { phase, roundNumber, thirdPlace },
      payload,
    );
    if (!res.ok) {
      toast(res.error, 'error');
      setSaving(false);
      return;
    }
    toast(said, 'success');
    router.refresh();
    setSaving(false);
  }

  function pick(choiceId: string) {
    if (choiceId === CUSTOM) {
      // Opening the fields is not a decision, so nothing is written. The shape
      // on screen is the seed; its numbers are always in bounds and always odd.
      setDraft({ games: String(rules.bestOf), points: String(rules.target) });
      return;
    }
    setDraft(null);
    if (choiceId === 'inherit') {
      void save(null, 'Round follows the event again');
      return;
    }
    const preset = PRESETS.find((c) => c.id === choiceId);
    if (!preset) return;
    void save(
      { games_per_match: preset.games, points_per_game: preset.points },
      `Round set to ${shapeLabel(preset.games, preset.points)}`,
    );
  }

  const draftGames = Number(draft?.games);
  const draftPoints = Number(draft?.points);
  const draftLegal = isLegalCustomGames(draftGames) && isLegalCustomPoints(draftPoints);
  // Nothing to apply when the typed pair is what is already saved — an Apply
  // that writes the current value would report success for a no-op.
  const draftChanged =
    draftLegal
    && (draftGames !== (first?.games_per_match ?? null) || draftPoints !== (first?.points_per_game ?? null));

  function applyDraft() {
    if (!draftChanged) return;
    void save(
      { games_per_match: draftGames, points_per_game: draftPoints },
      `Round set to ${shapeLabel(draftGames, draftPoints)}`,
    );
  }

  const label = thirdPlace
    ? 'What the third-place playoff is played to'
    : `What round ${roundNumber} is played to`;

  const weightLine = (
    <span
      className="block font-mono text-[10px] leading-tight text-[var(--text-muted)]"
      title={elo.spoken}
    >
      <span className="sr-only">{elo.spoken}</span>
      <span aria-hidden="true">Elo {elo.short}</span>
    </span>
  );

  if (locked) {
    const text = (
      <span className="text-[11px] font-medium text-[var(--text-secondary)]">{resolved}</span>
    );
    // No select chrome on a row that cannot be edited, and no 44px floor either
    // — the floor is a rule about things you can press.
    return variant === 'control' ? (
      text
    ) : (
      <span className="inline-flex flex-col gap-0.5">{text}{weightLine}</span>
    );
  }

  const customOpen = draft !== null || selected === CUSTOM;
  const shownGames = draft?.games ?? String(rules.bestOf);
  const shownPoints = draft?.points ?? String(rules.target);
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;

  const control = (
    <span className="flex flex-col gap-1.5">
      <label className="flex items-center">
        <span className="sr-only">{label}</span>
        <select
          value={customOpen ? CUSTOM : selected}
          disabled={saving}
          onChange={(e) => pick(e.target.value)}
          aria-label={label}
          className="w-full min-h-[44px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
        >
          <option value="inherit">Same as event ({eventShape})</option>
          {PRESETS.map((c) => (
            <option key={c.id} value={c.id}>
              {shapeLabel(c.games, c.points)}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>

      {customOpen && (
        <span className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <label className="flex items-center gap-1">
              <span className="sr-only">Games (best of), for {label}</span>
              <input
                type="number"
                inputMode="numeric"
                min={minGames}
                max={maxGames}
                step={2}
                value={shownGames}
                disabled={saving}
                onChange={(e) => setDraft({ games: e.target.value, points: shownPoints })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); applyDraft(); }
                }}
                aria-label={`Games (best of), for ${label}`}
                className="w-[52px] min-h-[44px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-center text-[12px] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              />
            </label>
            <span className="text-[11px] text-[var(--text-muted)]">to</span>
            <label className="flex items-center gap-1">
              <span className="sr-only">Points per game, for {label}</span>
              <input
                type="number"
                inputMode="numeric"
                min={minPoints}
                max={maxPoints}
                value={shownPoints}
                disabled={saving}
                onChange={(e) => setDraft({ games: shownGames, points: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); applyDraft(); }
                }}
                aria-label={`Points per game, for ${label}`}
                className="w-[56px] min-h-[44px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-center text-[12px] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              />
            </label>
            <button
              type="button"
              onClick={applyDraft}
              disabled={saving || !draftChanged}
              className="min-h-[44px] shrink-0 rounded-[8px] border border-[var(--color-accent)] px-2.5 text-[12px] font-medium text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:border-[var(--border)] disabled:text-[var(--text-muted)] disabled:opacity-60"
            >
              Apply
            </button>
          </span>
          {/* The same sentence the event-level fields give, so a bad number
              reads identically wherever it is typed. */}
          <span className="text-[10px] leading-snug text-[var(--text-muted)]">
            {customFormatHint(draftGames, draftPoints)}
          </span>
        </span>
      )}
    </span>
  );

  if (variant === 'control') return control;

  return (
    <span className="inline-flex flex-col gap-0.5">
      {control}
      {weightLine}
    </span>
  );
}
