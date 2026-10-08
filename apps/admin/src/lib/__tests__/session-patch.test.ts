import { describe, it, expect } from 'vitest';
import { sessionPatchSchema } from '@badminton/shared';
import {
  SESSION_PATCH_FIELDS,
  assertTimeOrder,
  buildSessionPatch,
  emptySessionEditForm,
  patchTouchesSomething,
  resolveSessionTimes,
  sessionEditProblem,
} from '../session-patch';

// THE ONE CLAIM THESE TESTS EXIST TO CHECK is that "leave this alone" and "clear
// this to NULL" stay two different things, all the way from the dialog to the
// UPDATE object.
//
// They are one careless line apart. `''` normalized to undefined, a truthiness
// test on the value, or `!== undefined` in place of `in` — any of the three
// turns "clear the time on these six Fridays" into "change nothing", and the
// officer gets a green toast saying six sessions were updated. Nothing else in
// the stack would notice: the write succeeds, the audit row is written, and the
// list still reads TIME NOT SET because it always did.

const form = (over: Partial<ReturnType<typeof emptySessionEditForm>> = {}) => ({
  ...emptySessionEditForm(),
  ...over,
});

describe('the three states of a time field', () => {
  it('leaves the key out entirely when the mode is "leave"', () => {
    const patch = buildSessionPatch(form());
    expect('start_time' in patch).toBe(false);
    expect('end_time' in patch).toBe(false);
  });

  it('sends an explicit null — a PRESENT key — when the mode is "clear"', () => {
    const patch = buildSessionPatch(form({ startMode: 'clear' }));
    expect('start_time' in patch).toBe(true);
    expect(patch.start_time).toBeNull();
  });

  it('sends the time when the mode is "set"', () => {
    const patch = buildSessionPatch(form({ startMode: 'set', startTime: '19:00' }));
    expect(patch.start_time).toBe('19:00');
  });

  it('omits the key rather than sending "" when "set" is chosen but nothing typed', () => {
    // A half-filled time control must not fail the whole patch and take a
    // location move typed beside it down with it.
    const patch = buildSessionPatch(form({ startMode: 'set', startTime: '', location: 'Central Gym' }));
    expect('start_time' in patch).toBe(false);
    expect(patch.location).toBe('Central Gym');
  });

  it('resolves an absent key and a null key to different stored values', () => {
    // The distinction the whole feature rests on, seen through the resolver the
    // server uses: leave keeps 18:00, clear really produces NULL.
    const stored = { start_time: '18:00', end_time: '20:00' };
    expect(resolveSessionTimes(stored, buildSessionPatch(form())).start).toBe('18:00');
    expect(resolveSessionTimes(stored, buildSessionPatch(form({ startMode: 'clear' }))).start).toBeNull();
  });
});

describe('patchTouchesSomething', () => {
  it('counts an explicit clear as a touch', () => {
    // Guards a `Boolean(value)` regression: Boolean(null) is false, and clearing
    // a time is one of the two edits this feature was asked for.
    expect(patchTouchesSomething({ start_time: null })).toBe(true);
  });

  it('is false for a patch nobody filled in', () => {
    expect(patchTouchesSomething({})).toBe(false);
    expect(patchTouchesSomething(buildSessionPatch(form()))).toBe(false);
  });
});

describe('sessionPatchSchema', () => {
  it('rejects "" rather than normalizing it into one of the three states', () => {
    // THE TRIPWIRE for reusing isoTimeSchema, which is wrapped in
    // blankAsUndefined and would turn '' into undefined — i.e. silently collapse
    // "clear the time" into "leave the time alone".
    expect(sessionPatchSchema.safeParse({ start_time: '' }).success).toBe(false);
    expect(sessionPatchSchema.safeParse({ end_time: '' }).success).toBe(false);
  });

  it('keeps absent and null distinguishable THROUGH the parse', () => {
    // The server iterates the PARSED object, not the one the dialog built, so
    // the distinction has to survive zod as well as buildSessionPatch.
    expect('start_time' in sessionPatchSchema.parse({ location: 'Central Gym' })).toBe(false);
    expect('start_time' in sessionPatchSchema.parse({ start_time: null })).toBe(true);
    expect(sessionPatchSchema.parse({ start_time: null }).start_time).toBeNull();
  });

  it('allows null only on the two nullable columns', () => {
    expect(sessionPatchSchema.safeParse({ start_time: null }).success).toBe(true);
    expect(sessionPatchSchema.safeParse({ end_time: null }).success).toBe(true);
    // NOT NULL / column-defaulted — there is no "clear" state to express.
    expect(sessionPatchSchema.safeParse({ name: null }).success).toBe(false);
    expect(sessionPatchSchema.safeParse({ location: null }).success).toBe(false);
    expect(sessionPatchSchema.safeParse({ track: null }).success).toBe(false);
  });

  it('refuses a key that is not on the allowlist, loudly', () => {
    // .strict(), because zod's default is to STRIP an unknown key — which would
    // make a hand-rolled POST carrying `status` look like it worked.
    for (const key of ['status', 'season_id', 'host_player_id', 'notes', 'require_scan_to_check_in']) {
      expect(sessionPatchSchema.safeParse({ [key]: 'x' }).success).toBe(false);
    }
  });

  it('does not accept `date`, and that absence is deliberate', () => {
    // Setting twelve nights to one date collapses a term into a single evening
    // and removes the only thing telling the rows apart — and the RSVP and
    // attendance rows already recorded against them would belong to a date
    // nobody played on. A date move stays in the per-row menu.
    expect(sessionPatchSchema.safeParse({ date: '2026-01-01' }).success).toBe(false);
  });

  it('still applies the ordinary field rules', () => {
    expect(sessionPatchSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(sessionPatchSchema.safeParse({ track: 'mixed' }).success).toBe(false);
    expect(sessionPatchSchema.safeParse({ track: 'competitive' }).success).toBe(true);
  });

  it('lists exactly the columns the server is allowed to write', () => {
    expect([...SESSION_PATCH_FIELDS].sort()).toEqual(
      Object.keys(sessionPatchSchema.shape).sort(),
    );
  });
});

describe('assertTimeOrder', () => {
  const stored = { start_time: '18:00', end_time: '20:00' };

  it('catches an end moved before the stored start', () => {
    // The cross-field case a patch schema CANNOT see: only end_time is in the
    // patch, and start_time is in the row.
    expect(() => assertTimeOrder(resolveSessionTimes(stored, { end_time: '17:00' }))).toThrow(
      /after start time/i,
    );
  });

  it('allows an end moved later', () => {
    expect(() => assertTimeOrder(resolveSessionTimes(stored, { end_time: '21:00' }))).not.toThrow();
  });

  it('checks a two-time patch against itself, not against the stored pair', () => {
    const late = { start_time: '22:00', end_time: '23:00' };
    expect(() =>
      assertTimeOrder(resolveSessionTimes(late, { start_time: '19:00', end_time: '21:00' })),
    ).not.toThrow();
  });

  it('allows a cleared start on a row that still has an end', () => {
    // All four NULL combinations are legal rows — 00110 documents them.
    expect(() => assertTimeOrder(resolveSessionTimes(stored, { start_time: null }))).not.toThrow();
  });
});

describe('the two sides arrive at different precision', () => {
  // Postgres TIME reads back HH:MM:SS; <input type="time"> emits HH:MM. Raw
  // string comparison is not just imprecise here, it fails in one direction:
  // '21:00:00' <= '21:00' is FALSE, so an equal pair read as "end after start".
  it('refuses a zero-length night when the stored end carries seconds', () => {
    expect(() =>
      assertTimeOrder(resolveSessionTimes({ end_time: '21:00:00' }, { start_time: '21:00' })),
    ).toThrow(/after start time/i);
  });

  it('refuses it in the other direction too', () => {
    expect(() =>
      assertTimeOrder(resolveSessionTimes({ start_time: '21:00:00' }, { end_time: '21:00' })),
    ).toThrow(/after start time/i);
  });

  it('still allows a real ordering across the two precisions', () => {
    expect(() =>
      assertTimeOrder(resolveSessionTimes({ end_time: '23:00:00' }, { start_time: '21:00' })),
    ).not.toThrow();
    expect(() =>
      assertTimeOrder(resolveSessionTimes({ start_time: '18:00:00' }, { end_time: '21:00' })),
    ).not.toThrow();
  });

  it('refuses an exactly equal pair at matching precision', () => {
    expect(() =>
      assertTimeOrder(resolveSessionTimes({}, { start_time: '21:00', end_time: '21:00' })),
    ).toThrow(/after start time/i);
  });
});

describe('sessionEditProblem', () => {
  // A one-character name fails min(2) for the WHOLE patch on EVERY selected
  // session, so it would silently take down a location move typed beside it.
  it('names a one-character name before the round trip', () => {
    const form = { ...emptySessionEditForm(), name: 'x' };
    expect(sessionEditProblem(form)).toMatch(/two characters/i);
  });

  it('counts trimmed length, not raw', () => {
    expect(sessionEditProblem({ ...emptySessionEditForm(), name: '  x  ' })).not.toBeNull();
  });

  it('is silent on an empty name, which means leave it alone', () => {
    expect(sessionEditProblem(emptySessionEditForm())).toBeNull();
  });

  it('is silent on a name the schema accepts', () => {
    expect(sessionEditProblem({ ...emptySessionEditForm(), name: 'Friday Open Play' })).toBeNull();
  });

  it('agrees with the schema about what min(2) rejects', () => {
    // Pinned against zod so the floor here cannot drift from the real one.
    const form = { ...emptySessionEditForm(), name: 'x' };
    expect(sessionPatchSchema.safeParse(buildSessionPatch(form)).success).toBe(false);
    const ok = { ...emptySessionEditForm(), name: 'xy' };
    expect(sessionEditProblem(ok)).toBeNull();
    expect(sessionPatchSchema.safeParse(buildSessionPatch(ok)).success).toBe(true);
  });
});
