import { describe, it, expect } from 'vitest';
import { splitFullName, joinName } from '../name';

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
