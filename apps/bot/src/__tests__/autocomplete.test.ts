import { describe, it, expect, vi, beforeEach } from 'vitest';

// The /profile handle picker.
//
// An autocomplete CANNOT be deferred: type 8 inside about three seconds is the
// only valid answer, and there is no second chance to send a better one. So the
// two properties worth pinning are that a failing app never turns into a thrown
// error the member sees, and that a member typing a handle does not open one
// request to the app per keystroke.

const fetchHandles = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchHandles,
}));

const MEMBERS = [
  { handle: 'ada', name: 'Ada Lam' },
  { handle: 'adam', name: 'Adam Roy' },
  { handle: 'badam', name: 'Bruce Tan' },
  { handle: 'kai', name: 'Kai Adamson' },
];

function focused(value: string) {
  return [{ name: 'handle', value, type: 3, focused: true }];
}

beforeEach(async () => {
  vi.resetAllMocks();
  const { invalidateHandleCache } = await import('../handles.js');
  invalidateHandleCache();
  fetchHandles.mockResolvedValue({ members: MEMBERS });
});

describe('matchHandles', () => {
  it('caps at Discord’s limit of 25', async () => {
    // Discord rejects the WHOLE response above 25, not the surplus rows, so a
    // large club would get a picker that suggests nothing at all.
    const { matchHandles } = await import('../handles.js');
    const many = Array.from({ length: 60 }, (_, i) => ({
      handle: `player${i}`,
      name: `Player ${i}`,
    }));

    expect(matchHandles(many, 'player')).toHaveLength(25);
    expect(matchHandles(many, '')).toHaveLength(25);
  });

  it('returns the head of the list before anything is typed', async () => {
    // The picker opens with an empty focused value; answering nothing there
    // makes it look broken.
    const { matchHandles } = await import('../handles.js');
    expect(matchHandles(MEMBERS, '')).toEqual(MEMBERS);
  });

  it('ranks handle prefixes above substrings and names, and ignores a leading @', async () => {
    const { matchHandles } = await import('../handles.js');
    expect(matchHandles(MEMBERS, '@ada').map((m) => m.handle)).toEqual([
      'ada',
      'adam',
      'badam',
      'kai',
    ]);
  });
});

describe('handleProfileAutocomplete', () => {
  it('answers with the BARE handle as the choice value', async () => {
    // The value lands straight in the option handleProfile hands to
    // fetchProfile, so anything decorative in it becomes a lookup for a handle
    // nobody has.
    const { handleProfileAutocomplete } = await import('../commands.js');
    const response = (await handleProfileAutocomplete(focused('ad'))) as {
      type: number;
      data: { choices: { name: string; value: string }[] };
    };

    expect(response.type).toBe(8);
    expect(response.data.choices[0]).toEqual({ name: 'Ada Lam (@ada)', value: 'ada' });
    expect(response.data.choices.every((c) => !c.value.startsWith('@'))).toBe(true);
  });

  it('answers with no choices rather than throwing when the app is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchHandles.mockRejectedValue(new Error('app unreachable'));

    const { handleProfileAutocomplete } = await import('../commands.js');
    const response = (await handleProfileAutocomplete(focused('ad'))) as {
      data: { choices: unknown[] };
    };

    expect(response.data.choices).toEqual([]);
  });
});

describe('loadHandles', () => {
  it('serves the cache rather than re-fetching inside the TTL', async () => {
    // An autocomplete fires per keystroke. Without this the picker is a load
    // generator pointed at the app.
    const { loadHandles } = await import('../handles.js');
    await loadHandles();
    await loadHandles();

    expect(fetchHandles).toHaveBeenCalledTimes(1);
  });

  it('issues exactly one fetch for concurrent callers on a cold cache', async () => {
    // The TTL cannot help here: nothing is cached yet, so every caller would
    // start its own fetch.
    const { loadHandles } = await import('../handles.js');
    await Promise.all([loadHandles(), loadHandles(), loadHandles()]);

    expect(fetchHandles).toHaveBeenCalledTimes(1);
  });

  it('serves the last good copy after a later fetch fails', async () => {
    // A stale list beats an empty picker, which to the member is
    // indistinguishable from a club with no handles in it.
    const log = vi.fn();
    const { loadHandles } = await import('../handles.js');
    const t0 = 1_000_000;
    await loadHandles(log, () => t0);

    fetchHandles.mockRejectedValue(new Error('app unreachable'));
    // Well past the TTL, so this genuinely re-fetches rather than reading the
    // cache — which is what makes the fallback the thing under test.
    expect(await loadHandles(log, () => t0 + 10 * 60_000)).toEqual(MEMBERS);
    expect(fetchHandles).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
  });
});
