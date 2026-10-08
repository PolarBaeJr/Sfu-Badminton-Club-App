import { describe, it, expect } from 'vitest';
import { normalizeExternalTeamNames, EXTERNAL_NAME_MAX } from '../external-team';

describe('normalizeExternalTeamNames', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeExternalTeamNames('  Alder   Finch ', 'Birch\tWren')).toEqual({
      ok: true,
      names: ['Alder Finch', 'Birch Wren'],
      teamName: null,
    });
  });

  it('accepts 1 and 60 characters and refuses 0 and 61', () => {
    expect(normalizeExternalTeamNames('A', 'x'.repeat(EXTERNAL_NAME_MAX)).ok).toBe(true);
    expect(normalizeExternalTeamNames('   ', 'Birch Wren').ok).toBe(false);
    expect(normalizeExternalTeamNames('Alder Finch', 'x'.repeat(EXTERNAL_NAME_MAX + 1)).ok).toBe(false);
  });

  it('refuses the same name twice, whatever the case or spacing', () => {
    const res = normalizeExternalTeamNames('Cedar Lark', ' cedar  LARK');
    expect(res).toEqual({ ok: false, error: 'The two players need different names.' });
  });

  it('refuses anything that is not a string', () => {
    expect(normalizeExternalTeamNames(null, 'Birch Wren').ok).toBe(false);
    expect(normalizeExternalTeamNames('Alder Finch', 42).ok).toBe(false);
    expect(normalizeExternalTeamNames(['Alder'], { name: 'x' }).ok).toBe(false);
  });

  it('tidies an optional team name and treats blank as none', () => {
    expect(normalizeExternalTeamNames('Alder Finch', 'Birch Wren', '  Night   Owls ')).toEqual({
      ok: true,
      names: ['Alder Finch', 'Birch Wren'],
      teamName: 'Night Owls',
    });
    const blank = normalizeExternalTeamNames('Alder Finch', 'Birch Wren', '   ');
    expect(blank.ok && blank.teamName).toBeNull();
    const absent = normalizeExternalTeamNames('Alder Finch', 'Birch Wren', null);
    expect(absent.ok && absent.teamName).toBeNull();
  });

  it('refuses a team name over 60 characters or not a string', () => {
    expect(normalizeExternalTeamNames('Alder Finch', 'Birch Wren', 'x'.repeat(EXTERNAL_NAME_MAX)).ok).toBe(true);
    expect(normalizeExternalTeamNames('Alder Finch', 'Birch Wren', 'x'.repeat(EXTERNAL_NAME_MAX + 1)).ok).toBe(false);
    expect(normalizeExternalTeamNames('Alder Finch', 'Birch Wren', 42).ok).toBe(false);
  });
});
