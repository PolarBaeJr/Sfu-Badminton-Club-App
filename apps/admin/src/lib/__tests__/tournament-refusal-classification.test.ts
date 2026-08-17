import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A source-level test, deliberately, because the alternative is standing up a
// mock Supabase for twenty actions to assert one word in each. The classification
// IS the thing at risk here: nothing about `throw new Error('Event is full')`
// looks wrong, it type-checks, it reaches the user correctly, and the only
// consequence is a Sentry issue nobody asked for.
//
// It reads both ways on purpose. The refusal list must stay marked so the four
// tournament routes stay quiet; the FAULT list must stay unmarked, and that is
// the assertion that matters — the "Could not check ... try again" family is a
// failed DB read, and 'Event not found' under RLS is indistinguishable from a
// row the caller cannot see, which expected-error.ts already argues has to stay
// loud (the 00032 fallout).

const DIR = fileURLToPath(new URL('../tournament-actions/', import.meta.url));
const read = (f: string) => readFileSync(`${DIR}${f}`, 'utf8');

const SOURCES = ['participants.ts', 'brackets.ts', 'events.ts', 'finalize.ts', 'seeding.ts'];
const ALL = SOURCES.map(read).join('\n');

// State guards a stale tab or a mistimed click can meet. Each message tells the
// person what to do instead, which is the tell that it is a refusal.
const REFUSALS = [
  'Draw is locked. Unlock it before making changes.',
  'Draw is locked. Unlock it before generating bracket.',
  'Draw is locked. Unlock it before generating matches.',
  'Draw is locked. Unlock it before changing seeds.',
  'Draw is locked. Unlock it before clearing seeds.',
  'Cannot add participants in current status',
  'Cannot add pairs in current status',
  'Event is full',
  'Player already registered for this event',
  'Need at least 2 participants to generate a bracket',
  'Need at least 3 participants for round robin',
  'Can only delete events in registration status',
  'Event must be completed first',
  'Event must be live to finalize',
  'Placement bonuses not enabled for this event',
];

// Genuine faults. A failed read, a failed revalidate, or a row that should be
// there and is not.
const FAULTS = [
  'Could not check this tournament’s event limit. Nothing was added — try again.',
  'Could not check how full this event is. Nothing was added — try again.',
  'Could not read player ratings. Nothing was added — try again.',
  'Saved, but the page could not be refreshed. Reload to see the change.',
  'Event not found',
  'Participant not found',
];

// 'Pair not found' is deliberately in NEITHER list. participants.ts throws it
// three times and already disagreed with itself before this change — twice as an
// ExpectedError (1368, 1491), once as a plain Error (1629) — so no single
// assertion is true of it. Left exactly as found rather than picking a side
// while changing something else: it wants deciding on its own, alongside
// 'Event not found', whose RLS-invisibility argument applies to it too.

describe('tournament-actions refusal classification', () => {
  it.each(REFUSALS)('is thrown as an ExpectedError: %s', (message) => {
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(ALL).toMatch(new RegExp(`throw new ExpectedError\\('${escaped}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new Error\\('${escaped}'\\)`));
  });

  it.each(FAULTS)('stays a plain Error so Sentry still hears about it: %s', (message) => {
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(ALL).toMatch(new RegExp(`throw new Error\\('${escaped}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new ExpectedError\\('${escaped}'\\)`));
  });
});
