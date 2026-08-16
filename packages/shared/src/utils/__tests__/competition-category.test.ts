import { describe, it, expect } from 'vitest';
import {
  COMPETITION_CATEGORIES,
  COMPETITION_CATEGORY_CHOICES,
  canPairForEvent,
  categoryRequiredBy,
  COMPETITION_CATEGORY_LOCKED_MESSAGE,
  isCompetitionCategory,
  isCompetitionCategoryLockedError,
  isOpenEvent,
  screenExecEntry,
  screenPair,
  screenSelfEntry,
  toCompetitionCategory,
  type CompetitionCategory,
} from '../competition-category';
import { adminPlayerUpdateSchema, profileSchema } from '../../validators/schemas';
import type { TournamentEventType } from '../../types/database';

const ALL_EVENTS: TournamentEventType[] = [
  'mens_singles', 'womens_singles', 'open_singles',
  'mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles',
];
const CATEGORIES: Array<CompetitionCategory | null> = ['mens', 'womens', null];

describe('the column has exactly two values, and null is the third state', () => {
  it('accepts the two and nothing else', () => {
    expect(COMPETITION_CATEGORIES).toEqual(['mens', 'womens']);
    expect(isCompetitionCategory('mens')).toBe(true);
    expect(isCompetitionCategory('womens')).toBe(true);
    for (const other of ['non_binary', 'prefer_not_to_say', 'other', 'MENS', '', null, undefined, 1]) {
      expect(isCompetitionCategory(other)).toBe(false);
    }
  });

  // 00111: there is no 'declined' value because nothing distinguishes declining
  // from not having been asked. Both must arrive as null rather than throwing.
  it('narrows anything unrecognised — including a declined answer — to null', () => {
    expect(toCompetitionCategory('prefer_not_to_say')).toBeNull();
    expect(toCompetitionCategory(null)).toBeNull();
    expect(toCompetitionCategory(undefined)).toBeNull();
    expect(toCompetitionCategory('womens')).toBe('womens');
  });

  it('offers the member a way to say nothing, and it is the first option', () => {
    expect(COMPETITION_CATEGORY_CHOICES[0]!.value).toBe('');
    expect(COMPETITION_CATEGORY_CHOICES.map((c) => c.value)).toEqual(['', 'mens', 'womens']);
  });
});

describe('which events have a rule at all', () => {
  it('maps each event type to what it requires', () => {
    expect(categoryRequiredBy('mens_singles')).toBe('mens');
    expect(categoryRequiredBy('mens_doubles')).toBe('mens');
    expect(categoryRequiredBy('womens_singles')).toBe('womens');
    expect(categoryRequiredBy('womens_doubles')).toBe('womens');
    expect(categoryRequiredBy('mixed_doubles')).toBe('mixed');
    expect(categoryRequiredBy('open_singles')).toBeNull();
    expect(categoryRequiredBy('open_doubles')).toBeNull();
  });

  // The load-bearing promise of the whole design: a member who declares nothing
  // is never locked out of the club's tournaments.
  it('lets EVERY category, declared or not, into both open events', () => {
    for (const event of ['open_singles', 'open_doubles'] as const) {
      expect(isOpenEvent(event)).toBe(true);
      for (const category of CATEGORIES) {
        expect(screenSelfEntry(event, category).ok).toBe(true);
        expect(screenExecEntry(event, category, 'Sam').ok).toBe(true);
      }
      for (const a of CATEGORIES) {
        for (const b of CATEGORIES) expect(canPairForEvent(event, a, b)).toBe(true);
      }
    }
  });
});

describe('self-entry refuses the undeclared as well as the contradicting', () => {
  it('takes a member into the event their own category names', () => {
    expect(screenSelfEntry('mens_singles', 'mens').ok).toBe(true);
    expect(screenSelfEntry('womens_doubles', 'womens').ok).toBe(true);
  });

  it('refuses a contradiction, and says which event rather than which category', () => {
    const screen = screenSelfEntry('womens_singles', 'mens');
    expect(screen.ok).toBe(false);
    if (screen.ok) return;
    expect(screen.reason).toBe('mismatch');
    expect(screen.message).toContain("Women's Singles");
    // A screenshot of this refusal must disclose nothing about the member.
    expect(screen.message).not.toMatch(/\bmens\b|\bmen's category\b/i);
    // 00129. A mismatch is only ever reached by a member who has ALREADY
    // declared, and that is exactly the member the write-once lock refuses —
    // so this branch must not send them to Settings to do a write the database
    // will reject. The remedy is an exec.
    expect(screen.message).toContain('exec');
    expect(screen.message).not.toContain('Settings');
  });

  it('refuses an undeclared member and hands them all three remedies', () => {
    const screen = screenSelfEntry('mens_doubles', null);
    expect(screen.ok).toBe(false);
    if (screen.ok) return;
    expect(screen.reason).toBe('undeclared');
    expect(screen.message).toContain('Settings');
    expect(screen.message).toContain('Open');
    expect(screen.message).toContain('admin');
  });

  // Mixed needs one of each, so either declaration is a usable half — but an
  // undeclared entrant is somebody auto pair has no way to place.
  it('takes either declared category into mixed, and refuses only the undeclared', () => {
    expect(screenSelfEntry('mixed_doubles', 'mens').ok).toBe(true);
    expect(screenSelfEntry('mixed_doubles', 'womens').ok).toBe(true);
    const screen = screenSelfEntry('mixed_doubles', null);
    expect(screen.ok).toBe(false);
    if (!screen.ok) expect(screen.reason).toBe('undeclared');
  });
});

describe('console entry refuses only a contradiction', () => {
  // The rule that lets this ship at all: on the day 00111 applies, every member
  // in the club is undeclared.
  it('waves an undeclared member into every gendered event', () => {
    for (const event of ALL_EVENTS) {
      expect(screenExecEntry(event, null, 'Sam').ok).toBe(true);
    }
  });

  it('refuses a declared member from the other category, by name', () => {
    const screen = screenExecEntry('womens_doubles', 'mens', 'Jordan Lee');
    expect(screen.ok).toBe(false);
    if (screen.ok) return;
    expect(screen.reason).toBe('mismatch');
    expect(screen.message).toContain('Jordan Lee');
    expect(screen.message).toContain("Women's Doubles");
  });

  it('never refuses a single entrant from mixed — that rule is about the pair', () => {
    for (const category of CATEGORIES) {
      expect(screenExecEntry('mixed_doubles', category, 'Sam').ok).toBe(true);
    }
  });

  // The asymmetry, stated as a test so that collapsing the two functions into
  // one breaks something.
  it('is strictly more permissive than self-entry, on every combination', () => {
    for (const event of ALL_EVENTS) {
      for (const category of CATEGORIES) {
        if (screenSelfEntry(event, category).ok) {
          expect(screenExecEntry(event, category, 'Sam').ok).toBe(true);
        }
      }
    }
  });
});

describe('the mixed doubles pair rule', () => {
  it('takes one of each', () => {
    expect(canPairForEvent('mixed_doubles', 'mens', 'womens')).toBe(true);
    expect(canPairForEvent('mixed_doubles', 'womens', 'mens')).toBe(true);
  });

  it('refuses two of the same, and says what to do about it', () => {
    const screen = screenPair(
      'mixed_doubles',
      { category: 'mens', name: 'Alex' },
      { category: 'mens', name: 'Chris' },
    );
    expect(screen.ok).toBe(false);
    if (screen.ok) return;
    expect(screen.message).toContain('Alex');
    expect(screen.message).toContain('Chris');
    expect(screen.message).toContain('Open Doubles');
  });

  // An undeclared half cannot make the pair PROVABLY wrong, which is where every
  // console check in this design draws its line.
  it('allows a pair with an undeclared half, whatever the other half declared', () => {
    for (const other of CATEGORIES) {
      expect(canPairForEvent('mixed_doubles', null, other)).toBe(true);
      expect(canPairForEvent('mixed_doubles', other, null)).toBe(true);
    }
  });

  it('screens each half independently in a same-category doubles event', () => {
    expect(canPairForEvent('mens_doubles', 'mens', 'mens')).toBe(true);
    expect(canPairForEvent('mens_doubles', 'mens', 'womens')).toBe(false);
    expect(canPairForEvent('mens_doubles', 'mens', null)).toBe(true);
  });

  it('keeps canPairForEvent and screenPair answering identically, everywhere', () => {
    for (const event of ALL_EVENTS) {
      for (const a of CATEGORIES) {
        for (const b of CATEGORIES) {
          expect(canPairForEvent(event, a, b)).toBe(
            screenPair(event, { category: a, name: 'A' }, { category: b, name: 'B' }).ok,
          );
        }
      }
    }
  });
});

describe('who may write the column', () => {
  it('is accepted by the member’s own profile schema, including a clear', () => {
    const base = { first_name: 'Sam', last_name: 'Lee' };
    expect(profileSchema.parse({ ...base, competition_category: 'womens' }).competition_category)
      .toBe('womens');
    expect(profileSchema.parse({ ...base, competition_category: null }).competition_category)
      .toBeNull();
    expect(profileSchema.safeParse({ ...base, competition_category: 'non_binary' }).success)
      .toBe(false);
  });

  // THE ABSENCE THAT USED TO BE HERE IS GONE, AND ON PURPOSE. Until 00129 this
  // test asserted that adminPlayerUpdateSchema DROPS the key, on 00111's reading
  // that only the member ever sets their own category. The field is now
  // write-once for the member — a database trigger refuses their second write —
  // so somebody has to be able to correct it, and the club owner said an exec.
  //
  // What replaces the absence is not another schema check. It is the trigger:
  // `authenticated` holds a column UPDATE grant, so no TypeScript boundary was
  // ever what stopped a member, and pretending otherwise is what this inversion
  // is here to prevent a reader concluding.
  it('is now accepted by the console’s player-update schema, so an exec can correct it', () => {
    const parsed = adminPlayerUpdateSchema.parse({
      status: 'competitive',
      reason: 'member asked us to fix it',
      competition_category: 'mens',
    } as Record<string, unknown>);
    expect(parsed.competition_category).toBe('mens');
  });

  // The exec's route back to "prefer not to say", which after 00129 is the only
  // one there is: a member cannot clear their own, because clear-then-set would
  // be the whole lock in two requests.
  it('lets the console clear it back to undeclared', () => {
    const parsed = adminPlayerUpdateSchema.parse({
      reason: 'member asked us to withdraw it',
      competition_category: null,
    } as Record<string, unknown>);
    expect(parsed.competition_category).toBeNull();
  });

  it('still refuses a third value on both sides', () => {
    expect(adminPlayerUpdateSchema.safeParse({
      reason: 'x', competition_category: 'non_binary',
    }).success).toBe(false);
  });
});

// The lock's refusal, as the app has to recognise it coming back from
// PostgREST. Narrow on purpose: 42501 is also what an RLS refusal and a missing
// grant raise, and reporting one of those to a member as "gender is set once"
// would send them to an exec who cannot help.
describe('recognising the write-once refusal', () => {
  it('matches the trigger’s own error and nothing else', () => {
    expect(isCompetitionCategoryLockedError({
      code: '42501', message: COMPETITION_CATEGORY_LOCKED_MESSAGE,
    })).toBe(true);
    expect(isCompetitionCategoryLockedError({
      code: '42501', message: 'permission denied for table players',
    })).toBe(false);
    expect(isCompetitionCategoryLockedError({
      code: '23505', message: COMPETITION_CATEGORY_LOCKED_MESSAGE,
    })).toBe(false);
    expect(isCompetitionCategoryLockedError(null)).toBe(false);
    expect(isCompetitionCategoryLockedError(undefined)).toBe(false);
  });

  // The sentence the member reads is the sentence the database raises. If these
  // two ever drift, a member gets one explanation from the form and a different
  // one from a direct call, and 00129's RAISE is where the other copy lives.
  it('is the same sentence the migration raises', () => {
    expect(COMPETITION_CATEGORY_LOCKED_MESSAGE)
      .toBe('Gender is set once. Ask an exec to change it.');
  });
});
