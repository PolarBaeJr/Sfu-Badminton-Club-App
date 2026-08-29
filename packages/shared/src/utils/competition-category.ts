/**
 * WHO MAY ENTER A GENDERED TOURNAMENT EVENT.
 *
 * event_type has said 'mens_singles' and 'womens_doubles' since 00001 and
 * nothing enforced either, because there was nothing on `players` to enforce
 * them against. 00111 adds one column, and this file is the whole rule built on
 * it — pure, so the same sentences are produced by the player app's self-entry,
 * by all four console entry paths, and by the tests, and none of them can drift.
 *
 * READ 00111'S COMMENT BLOCK BEFORE CHANGING ANYTHING HERE. It records why the
 * field is a COMPETITION CATEGORY and not a gender identity, why there are two
 * values and not three, why NULL covers both "not asked yet" and "prefer not to
 * say", and why self-entry refuses where exec entry does not. The functions
 * below are that reasoning in code and are not independently defensible.
 *
 * THE REFUSALS BELOW STILL NAME THE EVENT, NEVER THE CATEGORY. That has not
 * changed and must not: a refusal is read on a screen somebody else may be
 * looking at, and it discloses nothing by naming the draw a person cannot enter
 * rather than the one they are in.
 *
 * WHAT DID CHANGE (00129). 00111 said "no screen in either app shows a member's
 * category". Two now do, and both deliberately: the member's own Settings, and
 * the member Edit dialog in the console — because the club owner asked for the
 * field to be lockable, and an exec cannot change a value they are not shown.
 * `COMPETITION_CATEGORY_CHOICES` is what both draw. There is still no
 * `categoryLabel(category)` export and there must not be one: a bare formatter
 * is what would put the value on a roster row or a tournament list by accident.
 */

import type { CompetitionCategory, TournamentEventType } from '../types/database';
import { TOURNAMENT_EVENT_TYPE_LABELS } from './constants';

export type { CompetitionCategory };

export const COMPETITION_CATEGORIES: readonly CompetitionCategory[] = ['mens', 'womens'] as const;

export function isCompetitionCategory(value: unknown): value is CompetitionCategory {
  return value === 'mens' || value === 'womens';
}

/** Anything off the wire, narrowed to the column's three legal states. */
export function toCompetitionCategory(value: unknown): CompetitionCategory | null {
  return isCompetitionCategory(value) ? value : null;
}

/**
 * The two places a category is written as words on a screen: the member's own
 * Settings control, and the exec's member Edit dialog in the console.
 *
 * THE LABELS MOVED IN 00129 AND THE VALUES DID NOT. They used to read "Men's
 * events" / "Women's events", phrased as the draw rather than as the person,
 * because the control above them was headed "Tournament events". The club owner
 * renamed that heading to "Gender", and "Gender: Men's events" is not a
 * sentence — so the option text is now plain. The STORED values are untouched
 * and still name draws; see 00129 on why the two-value enum was not reopened at
 * the same time.
 *
 * The empty option is offered explicitly and is not a lockout: it is the state
 * every member starts in, and it keeps every Open event and the whole rest of
 * the app available. It is also, after 00129, the only one of the three a
 * member cannot come back to on their own — the field is write-once for them.
 */
export const COMPETITION_CATEGORY_CHOICES: ReadonlyArray<{
  value: CompetitionCategory | '';
  label: string;
}> = [
  { value: '', label: 'Prefer not to say' },
  { value: 'mens', label: 'Man' },
  { value: 'womens', label: 'Woman' },
] as const;

/**
 * The sentence a member sees when the lock refuses their write, and the one the
 * database raises. KEPT IDENTICAL IN BOTH PLACES on purpose: the trigger's
 * message is what a hand-rolled PostgREST call gets, and the app's is what the
 * form gets, and a member comparing the two should not find two different
 * accounts of the same rule.
 */
export const COMPETITION_CATEGORY_LOCKED_MESSAGE =
  'Gender is set once. Ask an exec to change it.';

/**
 * Did this Postgres error come from the write-once lock (00129)?
 *
 * Shaped exactly like isHandleTakenError: a SQLSTATE plus a discriminator, so
 * an unrelated privilege error is not silently reported to the member as a
 * locked field. 42501 is `insufficient_privilege`, which is also what an RLS
 * refusal and a missing grant raise — hence the message test as well.
 *
 * Callers turn a true here into an ExpectedError. Without that the refusal
 * reaches the member as a raw Postgres string and Sentry as an unknown
 * exception, which is exactly the noise a deliberate, reachable refusal should
 * never generate.
 */
export function isCompetitionCategoryLockedError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  return error.code === '42501'
    && (error.message ?? '').includes(COMPETITION_CATEGORY_LOCKED_MESSAGE);
}

/**
 * What an event requires of a single entrant.
 *
 *   a category  — mens_singles, mens_doubles, womens_singles, womens_doubles
 *   'mixed'     — mixed_doubles: the rule is about the PAIR, and about a single
 *                 entrant only to the extent that an undeclared person cannot be
 *                 placed on one
 *   null        — open_singles, open_doubles: OPEN TO EVERYBODY, including
 *                 members who have declared nothing. This is the whole reason
 *                 an undeclared member is never locked out of the club's
 *                 tournaments, so it is the first thing every caller checks.
 */
export function categoryRequiredBy(
  eventType: TournamentEventType,
): CompetitionCategory | 'mixed' | null {
  switch (eventType) {
    case 'mens_singles':
    case 'mens_doubles':
      return 'mens';
    case 'womens_singles':
    case 'womens_doubles':
      return 'womens';
    case 'mixed_doubles':
      return 'mixed';
    case 'open_singles':
    case 'open_doubles':
      return null;
  }
}

/** True for the events this whole file has no opinion about. */
export function isOpenEvent(eventType: TournamentEventType): boolean {
  return categoryRequiredBy(eventType) === null;
}

/**
 * Why an entry was refused.
 *
 *   'undeclared' — the member has not said which draw they compete in. REACHED
 *                  ONLY BY SELF-ENTRY: an exec adding somebody by hand is an
 *                  explicit override and is never refused for this.
 *   'mismatch'   — the member declared a category and it is not this event's.
 *                  Refused on every path, and the only one an exec may override.
 */
export type CategoryRefusalReason = 'undeclared' | 'mismatch';

export type CategoryScreen =
  | { ok: true }
  | { ok: false; reason: CategoryRefusalReason; message: string };

const OK: CategoryScreen = { ok: true };

/**
 * SELF-ENTRY. The member is entering themselves, so the app is the only thing
 * standing between the label and a draw that does not match it.
 *
 * REFUSES ON UNDECLARED AS WELL AS ON MISMATCH, which is the one place this
 * file is stricter than the console, and deliberately: a rule that let every
 * undeclared member into every gendered event would enforce nothing at all on
 * the day it shipped, since every member is undeclared on that day. The cost is
 * one control in Settings, and the refusal says where it is.
 *
 * MIXED IS A SPECIAL CASE AT SELF-ENTRY and only there: any declaration will
 * do, because a mixed pair needs one of each and either value can be one of
 * each. What it cannot do is take an entrant nothing can place — 00102 pairs
 * people AFTER they enter, so an undeclared member in a mixed pool is somebody
 * auto pair has to leave sitting there.
 */
export function screenSelfEntry(
  eventType: TournamentEventType,
  category: CompetitionCategory | null,
): CategoryScreen {
  const required = categoryRequiredBy(eventType);
  if (required === null) return OK;

  if (category === null) {
    return { ok: false, reason: 'undeclared', message: categoryRefusalMessage(eventType, 'undeclared') };
  }

  // Mixed takes either declared category — the pair rule does the rest.
  if (required === 'mixed' || category === required) return OK;

  return { ok: false, reason: 'mismatch', message: categoryRefusalMessage(eventType, 'mismatch') };
}

/**
 * THE TWO SELF-ENTRY REFUSAL SENTENCES, lifted out so the DATABASE can reach
 * them (00200).
 *
 * enter_tournament_event re-asks the category question under the field lock,
 * because an exec may change a member's Gender in the window between the screen
 * below and the insert. That function returns a REASON CODE and nothing else —
 * never the member's category, which is what preserves the disclosure property
 * the mismatch branch describes. So the sentence has to be built app-side, from
 * the event type the caller already holds.
 *
 * It is built HERE rather than written a second time at that call site for one
 * reason: a member must not get two different sentences for the same refusal
 * depending on whether they happened to lose the race.
 */
export function categoryRefusalMessage(
  eventType: TournamentEventType,
  reason: CategoryRefusalReason,
): string {
  // Unreachable for an Open event on both paths — screenSelfEntry returns OK
  // before it can ask, and the database refuses only for gendered event types.
  // 'mixed' is the wording that stays true if that ever stops holding, because
  // it names no category the member might not have.
  const required = categoryRequiredBy(eventType) ?? 'mixed';
  const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[eventType];

  if (reason === 'undeclared') {
    return (
      `${eventLabel} is entered by members who compete in ` +
      (required === 'mixed'
        ? 'a named category'
        : `the ${required === 'mens' ? "men's" : "women's"} category`) +
      // "Gender in Settings" since 00129 — the control used to be headed
      // "Tournament events" and a remedy that names a label the app no longer
      // shows is not a remedy. Still three ways out, and still in this order:
      // the one the member can act on now, the one that needs nothing, and
      // the one that needs somebody else.
      '. Set your Gender in Settings, or enter an Open event instead. ' +
      'A tournament admin can also enter you by hand.'
    );
  }

  // Says which event they are not eligible for, never which category they
  // are. The member knows their own answer; the sentence does not repeat it
  // back, so a screenshot of a refusal discloses nothing.
  //
  // THE REMEDY CHANGED IN 00129 AND HAD TO. This branch is reached ONLY by a
  // member who has already declared — that is what makes it a mismatch rather
  // than an 'undeclared' — and that is exactly the member the write-once lock
  // refuses. "Change it in Settings" was still true when they could; after
  // 00129 it sends them to a control that is no longer there to do a write
  // the database would reject. An exec is the remedy now, and it is the same
  // remedy COMPETITION_CATEGORY_LOCKED_MESSAGE names.
  return (
    `${eventLabel} is not open to your declared Gender. ` +
    'Enter an Open event instead, or ask an exec if your Gender is wrong.'
  );
}


/**
 * CONSOLE ENTRY, single entrant. An exec is adding somebody by hand.
 *
 * REFUSES ONLY ON CONTRADICTION. An undeclared member passes, which is the rule
 * the membership gate already follows for exactly this path — "adding someone by
 * hand in the admin app is an explicit override, not a loophole"
 * (apps/player/src/lib/tournament-actions.ts). It is also the only version that
 * can ship: every member is undeclared the day 00111 applies, so refusing the
 * undeclared would refuse every console add to every gendered event until the
 * whole roster had filled in a form.
 *
 * `name` is interpolated because these refusals are read by an exec at a desk
 * with the person standing in front of them, and the batch path reports one
 * message per player. Pass the name; 'This player' is the fallback the rest of
 * participants.ts already uses.
 */
export function screenExecEntry(
  eventType: TournamentEventType,
  category: CompetitionCategory | null,
  name: string,
): CategoryScreen {
  const required = categoryRequiredBy(eventType);
  if (required === null || category === null) return OK;
  // Mixed constrains the PAIR, not the person: either declared category can be
  // half of a mixed team, so there is nothing to refuse at single entry.
  if (required === 'mixed' || category === required) return OK;

  return {
    ok: false,
    reason: 'mismatch',
    message:
      `${name} competes in a different category from ${TOURNAMENT_EVENT_TYPE_LABELS[eventType]}. ` +
      'Enter them anyway only if the club has agreed to it.',
  };
}

/**
 * THE PAIR RULE. Applied wherever a team is formed or altered — addPairToEvent,
 * swapPairMember, and every pair auto pair proposes.
 *
 * MIXED IS THE ONLY EVENT WITH A RULE ABOUT THE PAIR RATHER THAN THE PEOPLE: one
 * 'mens' and one 'womens'. mens_doubles and womens_doubles constrain each half
 * independently, so they are screened by screenExecEntry per player and this
 * function only re-states that for the pair path.
 *
 * AN UNDECLARED HALF DOES NOT REFUSE A MIXED PAIR. It cannot make the pair
 * provably wrong, and "not provably wrong" is exactly where the console's line
 * sits everywhere else in this file.
 *
 * DO NOT "FIX" addPairToEvent BY CALLING THIS UNCONDITIONALLY. It calls this
 * only for `mixed_doubles`, and screens the same-category events per half —
 * and only for a half who is ENTERING, never for one being promoted out of the
 * pool. That is not an oversight. Re-screening a promoted half would refuse a
 * pairing on a rule an exec had already, deliberately, overridden when they let
 * that person into the event, stranding them in a pool nobody may pair them out
 * of. This function stays complete because canPairForEvent is defined as its
 * boolean form and auto pair plans against that.
 */
export function screenPair(
  eventType: TournamentEventType,
  first: { category: CompetitionCategory | null; name: string },
  second: { category: CompetitionCategory | null; name: string },
): CategoryScreen {
  const required = categoryRequiredBy(eventType);
  if (required === null) return OK;

  if (required === 'mixed') {
    // Both declared and the SAME is the only provable contradiction.
    if (first.category !== null && first.category === second.category) {
      return {
        ok: false,
        reason: 'mismatch',
        message:
          `${first.name} and ${second.name} compete in the same category, and a Mixed Doubles pair ` +
          'is one of each. Pair one of them with somebody from the other category, ' +
          'or enter this team in Open Doubles.',
      };
    }
    return OK;
  }

  for (const half of [first, second]) {
    const screen = screenExecEntry(eventType, half.category, half.name);
    if (!screen.ok) return screen;
  }
  return OK;
}

/**
 * Could these two ever be a legal team in this event? The predicate auto pair
 * plans against, with no message attached — it is asked once per candidate PAIR
 * while folding, and building a sentence for a combination that is simply not
 * chosen would be work for nothing.
 *
 * Deliberately the same answer screenPair gives, in boolean form, and the test
 * pins the two together so a change to one cannot quietly leave the other.
 */
export function canPairForEvent(
  eventType: TournamentEventType,
  a: CompetitionCategory | null,
  b: CompetitionCategory | null,
): boolean {
  return screenPair(eventType, { category: a, name: 'A' }, { category: b, name: 'B' }).ok;
}
