// The three states of a bulk session edit, with no React in it.
//
// A PLAIN MODULE ON PURPOSE, the same reason selection-model.ts is one: the
// console's test setup runs in `environment: 'node'` with no DOM, so anything
// left inside the bulk bar component could not be tested at all. What lives here
// is the part that is dangerous to get wrong.
//
// THREE STATES, NOT TWO. Every bulk-editable field on /players is non-nullable,
// so "leave as they are" vs "set to X" was the whole problem there.
// sessions.start_time and sessions.end_time are NULLABLE — the "TIME NOT SET"
// the list shows IS the NULL state — so a session patch has to be able to say
// three different things about one column:
//
//   * LEAVE it alone     -> the key is ABSENT from the patch object;
//   * CLEAR it to NULL    -> the key is present, holding `null`;
//   * SET it to a time    -> the key is present, holding a validated string.
//
// '' IS NEVER ONE OF THEM. It is rejected by sessionPatchSchema rather than
// normalized, because normalizing it would have to pick one of the three and
// whichever it picked would be silently wrong. The encoder below therefore omits
// a key rather than ever emitting ''.

import type { SessionPatchInput } from '@badminton/shared';

/**
 * The sessions columns a bulk patch may write, and nothing else.
 *
 * THE SERVER ITERATES THIS RATHER THAN SPREADING THE CLIENT'S PAYLOAD. It lives
 * here, not in the action file, because actions/sessions.ts is 'use server' and
 * may only export async functions — a constant declared there could be neither
 * shared nor asserted (the same constraint that put requireReason in
 * lib/audit-reason).
 */
export const SESSION_PATCH_FIELDS = [
  'name',
  'location',
  'start_time',
  'end_time',
  'track',
] as const satisfies readonly (keyof SessionPatchInput)[];

/** What one of the two time controls in the bulk dialog is currently saying. */
export type TimeMode = 'leave' | 'set' | 'clear';

/** The bulk Edit dialog's raw control state, before it becomes a patch. */
export interface SessionEditFormState {
  /** '' means "leave as they are" — the two-state sentinel /players uses. */
  name: string;
  /** '' means "leave as they are". LocationField's own unset value. */
  location: string;
  /** '' means "leave as they are"; otherwise a sessionGroupSchema value. */
  track: string;
  startMode: TimeMode;
  startTime: string;
  endMode: TimeMode;
  endTime: string;
}

/** A field left on this in the dialog is not written at all. */
export const NO_CHANGE = '';

export function emptySessionEditForm(): SessionEditFormState {
  return {
    name: NO_CHANGE,
    location: NO_CHANGE,
    track: NO_CHANGE,
    startMode: 'leave',
    startTime: '',
    endMode: 'leave',
    endTime: '',
  };
}

/**
 * Dialog state -> the patch the server is sent.
 *
 * Keys are assigned conditionally rather than set to `undefined`, because
 * "present but undefined" is a fourth state nobody wants: `in` says the field
 * was touched while the value says nothing was chosen.
 */
export function buildSessionPatch(form: SessionEditFormState): SessionPatchInput {
  const patch: SessionPatchInput = {};
  if (form.name !== NO_CHANGE) patch.name = form.name;
  if (form.location !== NO_CHANGE) patch.location = form.location;
  if (form.track !== NO_CHANGE) patch.track = form.track as SessionPatchInput['track'];
  // 'set' with an empty box OMITS the key. Sending '' would be rejected by the
  // schema as a whole-patch failure, so a half-filled time control must not
  // sabotage a location move typed beside it.
  if (form.startMode === 'clear') patch.start_time = null;
  else if (form.startMode === 'set' && form.startTime !== '') patch.start_time = form.startTime;
  if (form.endMode === 'clear') patch.end_time = null;
  else if (form.endMode === 'set' && form.endTime !== '') patch.end_time = form.endTime;
  return patch;
}

/**
 * Did the officer actually ask for anything?
 *
 * A NAMED PREDICATE, not `Object.values(patch).some(Boolean)` inline, because a
 * truthiness test is exactly the thing that gets this wrong: `{ start_time:
 * null }` is a deliberate clear and one of the two edits this feature was asked
 * for, and `Boolean(null)` would throw it away.
 */
export function patchTouchesSomething(patch: SessionPatchInput): boolean {
  return Object.keys(patch).length > 0;
}

/** The two times a session will hold AFTER a patch is applied to it. */
export function resolveSessionTimes(
  stored: { start_time?: string | null; end_time?: string | null },
  patch: SessionPatchInput,
): { start: string | null; end: string | null } {
  // `in`, never `!== undefined`: an absent key keeps the stored value, and a
  // present `null` clears it. Testing for undefined collapses the two.
  return {
    start: 'start_time' in patch ? patch.start_time ?? null : stored.start_time ?? null,
    end: 'end_time' in patch ? patch.end_time ?? null : stored.end_time ?? null,
  };
}

/**
 * Refuse a night that ends before it begins.
 *
 * NOTHING ELSE CATCHES THIS. There is no DB CHECK — 00110_session_instants.sql
 * says the `end_time < start_time` case is "preserved, not 'fixed'" — and
 * sessionPatchSchema cannot see it either, because a patch may move only one of
 * the two times while the other stays in the row. Left out, a bulk edit would
 * happily write twelve nights that close before they open, and the generated
 * ends_at is built from the bad value.
 *
 * Zero-padded HH:MM[:SS] compares correctly lexicographically — the same
 * assumption sessionCreateSchema's own refine already makes.
 */
/**
 * `HH:MM` and `HH:MM:SS` padded to the same width so they compare.
 *
 * THE TWO SIDES ARRIVE AT DIFFERENT PRECISION, which is the whole reason this
 * exists. Postgres `TIME` reads back as `HH:MM:SS`, while `<input type="time">`
 * emits `HH:MM`. Comparing them raw is not merely imprecise, it is wrong in one
 * direction: `'21:00:00' <= '21:00'` is FALSE, because the longer string with
 * the same prefix sorts higher. So a patch setting start to 21:00 against a
 * stored end of 21:00:00 read as "end is after start" and wrote a night that
 * ends the moment it begins. Ordering of genuinely different times was never
 * affected, which is exactly why it would have sat there unnoticed.
 */
function toSeconds(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

export function assertTimeOrder(resolved: { start: string | null; end: string | null }): void {
  const { start, end } = resolved;
  // Either one NULL on its own is legal: 00110 documents all four combinations,
  // and a start with no end means the night closes at
  // starts_at + default_duration_minutes.
  if (start === null || end === null) return;
  if (toSeconds(end) <= toSeconds(start)) throw new Error('End time must be after start time');
}

/**
 * The reason this edit cannot be submitted yet, or null when it can.
 *
 * Here rather than in the dialog because a one-character name is a footgun with
 * blast radius: `min(2)` fails the WHOLE patch for EVERY selected session, so a
 * stray keystroke in the name box silently takes down the location move typed in
 * beside it — twelve named per-record refusals and nothing changed. The refusals
 * are honest, but the officer should never get that far. The time boxes are
 * already guarded this way by omitting an empty value; this closes the one field
 * that had no equivalent.
 */
export function sessionEditProblem(form: SessionEditFormState): string | null {
  const name = form.name.trim();
  if (name.length === 1) return 'A name needs at least two characters.';
  return null;
}
