import { describe, it, expect } from 'vitest';
import { splitFullName, joinName, splitPairLabel } from '../name';

// The expectations here are the values 00023_split_player_name.sql produces
// for the same inputs — keep them in step with the migration.

describe('splitFullName', () => {
  it('leaves last_name null for a mononym', () => {
    expect(splitFullName('Cher')).toEqual({ first_name: 'Cher', last_name: null });
  });

  it('splits on the first space, so multi-word surnames stay whole', () => {
    expect(splitFullName('Jan van der Berg')).toEqual({
      first_name: 'Jan',
      last_name: 'van der Berg',
    });
  });

  it('trims and collapses whitespace runs', () => {
    expect(splitFullName('  Ada   Lovelace  ')).toEqual({
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
  });

  it('preserves non-ASCII names byte for byte', () => {
    expect(splitFullName('Zoë Étoile-Nguyễn')).toEqual({
      first_name: 'Zoë',
      last_name: 'Étoile-Nguyễn',
    });
  });

  it('round-trips the anonymized name used by purge-deleted-accounts', () => {
    const parts = splitFullName('Deleted Player');
    expect(parts).toEqual({ first_name: 'Deleted', last_name: 'Player' });
    expect(joinName(parts.first_name, parts.last_name)).toBe('Deleted Player');
  });
});

describe('joinName(splitFullName(x))', () => {
  it('is the identity for already-normalized names', () => {
    for (const name of ['Cher', 'Jan van der Berg', 'Deleted Player', 'Zoë Étoile-Nguyễn']) {
      const { first_name, last_name } = splitFullName(name);
      expect(joinName(first_name, last_name)).toBe(name);
    }
  });

  it('normalizes whitespace rather than reproducing it', () => {
    const { first_name, last_name } = splitFullName('  Ada   Lovelace  ');
    expect(joinName(first_name, last_name)).toBe('Ada Lovelace');
  });
});

// The draw cards stack a doubles pair one partner a line, which is only safe
// while "is this two names?" is answered by the separator the two apps actually
// join with and by nothing else — anything split by mistake gets cut in half on
// the chart.
describe('splitPairLabel', () => {
  it('splits the player app’s join', () => {
    expect(splitPairLabel('Jonathan Smithson & Katarzyna Kowalski'))
      .toEqual(['Jonathan Smithson', 'Katarzyna Kowalski']);
  });

  it('splits the console’s join', () => {
    expect(splitPairLabel('Jonathan Smithson / Katarzyna Kowalski'))
      .toEqual(['Jonathan Smithson', 'Katarzyna Kowalski']);
  });

  it('leaves a singles name and the placeholders alone', () => {
    expect(splitPairLabel('Katarzyna Kowalski')).toEqual(['Katarzyna Kowalski']);
    expect(splitPairLabel('TBD')).toEqual(['TBD']);
    expect(splitPairLabel('SKIP')).toEqual(['SKIP']);
  });

  // pair_name is free text. "Smash/Dash" has no spaces round the slash and is
  // one label; "R & D" is two, and stacking that is harmless.
  it('needs the separator to be spaced, so a slashed word stays whole', () => {
    expect(splitPairLabel('Smash/Dash')).toEqual(['Smash/Dash']);
    expect(splitPairLabel('Ampersand&Co')).toEqual(['Ampersand&Co']);
  });

  it('leaves anything that is not exactly two non-empty parts whole', () => {
    expect(splitPairLabel('A & B & C')).toEqual(['A & B & C']);
    expect(splitPairLabel('A &  & B')).toEqual(['A &  & B']);
  });
});
