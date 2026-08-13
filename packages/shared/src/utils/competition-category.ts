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
 * NOTHING HERE FORMATS THE CATEGORY FOR DISPLAY, on purpose. There is no
 * `categoryLabel(category)` export and there must not be one: no screen in
 * either app shows a member's category, and the refusals below are written to
 * name the EVENT a person is not eligible for rather than the category they
 * are. `COMPETITION_CATEGORY_CHOICES` exists only for the member's own settings
 * control — the one place the value is legitimately on screen, to its owner.
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
 * The member's own settings control, and the ONLY place a category is written
 * as words on a screen.
 *
 * Phrased as the event it lets you enter — "Men's events" — rather than as an
 * attribute of the member, because that is what the answer is used for and the
 * only thing the club needs to know. The empty option is offered explicitly and
 * is not a lockout: it is the state every member is in today, and it keeps every
 * Open event and the whole rest of the app available.
 */
export const COMPETITION_CATEGORY_CHOICES: ReadonlyArray<{
  value: CompetitionCategory | '';
  label: string;
}> = [
  { value: '', label: 'Prefer not to say' },
  { value: 'mens', label: "Men's events" },
  { value: 'womens', label: "Women's events" },
] as const;

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

  const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[eventType];

  if (category === null) {
    return {
      ok: false,
      reason: 'undeclared',
      message:
        `${eventLabel} is entered by members who compete in ` +
        (required === 'mixed'
          ? 'a named category'
          : `the ${required === 'mens' ? "men's" : "women's"} category`) +
        '. Set your competition category in Settings, or enter an Open event instead. ' +
        'A tournament admin can also enter you by hand.',
    };
  }

  // Mixed takes either declared category — the pair rule does the rest.
  if (required === 'mixed' || category === required) return OK;

  return {
    ok: false,
    reason: 'mismatch',
    // Says which event they are not eligible for, never which category they
    // are. The member knows their own answer; the sentence does not repeat it
    // back, so a screenshot of a refusal discloses nothing.
    message:
      `${eventLabel} is not open to your declared competition category. ` +
      'Enter an Open event instead, or change your category in Settings.',
  };
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
