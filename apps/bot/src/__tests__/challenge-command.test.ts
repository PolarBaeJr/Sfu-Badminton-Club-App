import { describe, it, expect, vi, beforeEach } from 'vitest';

// /challenge send and /challenge report act AS THE CALLER. The caller is read
// off the interaction and never from an option, every reply is ephemeral, and
// nothing is posted anywhere a channel would see it: the opponent hears about
// it the way the website tells them.

const { createChallenge, reportChallenge, fetchOpenChallenges } = vi.hoisted(() => ({
  createChallenge: vi.fn(),
  reportChallenge: vi.fn(),
  fetchOpenChallenges: vi.fn(),
}));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  createChallenge,
  reportChallenge,
  fetchOpenChallenges,
}));

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  LINKED_ACCOUNT_PICKERS,
  OPEN_CHALLENGE_PICKERS,
  dispatch,
  handleChallengeAutocomplete,
  parseChallengeScore,
} from '../commands.js';

const CALLER = '111111111111111111';
const OPPONENT = '222222222222222222';
const PARTNER = '333333333333333333';
const OPPONENT_PARTNER = '444444444444444444';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };

type Reply = { type: number; data: { content?: string; flags?: number; allowed_mentions?: unknown; choices?: { name: string; value: string }[] } };

function send(options: { name: string; value: string | number | boolean }[]) {
  return dispatch('challenge', [{ name: 'send', type: 1, options }], CONTEXT) as unknown as Promise<Reply>;
}

function report(options: { name: string; value: string | number | boolean }[]) {
  return dispatch('challenge', [{ name: 'report', type: 1, options }], CONTEXT) as unknown as Promise<Reply>;
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  createChallenge.mockResolvedValue({ ok: true, challengeId: 'challenge-1' });
  reportChallenge.mockResolvedValue({ ok: true, matchId: 'match-1', opponents: 'Ada Lovelace' });
  fetchOpenChallenges.mockResolvedValue([]);
  // Anything that reached for the network directly (a channel post, a DM)
  // would land here.
  vi.stubGlobal('fetch', fetchSpy);
});

describe('the definition', () => {
  const definition = COMMAND_DEFINITIONS.find((command) => command.name === 'challenge') as {
    options: { name: string; options: { name: string; required?: boolean; type: number; min_value?: number; max_value?: number; autocomplete?: boolean }[] }[];
  };

  it('has send and report, with every required option ahead of the optional ones', () => {
    expect(definition.options.map((sub) => sub.name)).toEqual(['send', 'report']);
    for (const sub of definition.options) {
      const firstOptional = sub.options.findIndex((o) => !o.required);
      if (firstOptional >= 0) expect(sub.options.slice(firstOptional).every((o) => !o.required)).toBe(true);
    }
  });

  it('requires a duration from 1 to 300 minutes on report', () => {
    const duration = definition.options[1]!.options.find((o) => o.name === 'duration');
    expect(duration).toMatchObject({ type: 4, required: true, min_value: 1, max_value: 300 });
  });

  it('is deferred, and its picker is the open-challenge one', () => {
    expect(DEFERRED_COMMANDS.has('challenge')).toBe(true);
    expect(OPEN_CHALLENGE_PICKERS.has('challenge')).toBe(true);
    expect(LINKED_ACCOUNT_PICKERS.has('challenge')).toBe(false);
  });
});

describe('parseChallengeScore', () => {
  it('reads games split by spaces or commas, the caller first', () => {
    expect(parseChallengeScore('21-15 18-21, 21:19')).toEqual({
      ok: true,
      games: [{ mine: 21, theirs: 15 }, { mine: 18, theirs: 21 }, { mine: 21, theirs: 19 }],
    });
  });

  it('refuses a blank score, a level game, nonsense and too many games', () => {
    expect(parseChallengeScore('').ok).toBe(false);
    expect(parseChallengeScore('21-21').ok).toBe(false);
    expect(parseChallengeScore('twenty-one').ok).toBe(false);
    expect(parseChallengeScore('21-0 21-0 21-0 21-0 21-0 21-0 21-0 21-0').ok).toBe(false);
    expect(parseChallengeScore('45-43').ok).toBe(false);
  });
});

describe('/challenge send', () => {
  it('sends the caller from the interaction and the defaults the web uses', async () => {
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);

    expect(createChallenge).toHaveBeenCalledWith({
      discordUserId: CALLER,
      opponentDiscordId: OPPONENT,
      type: 'singles',
      rated: true,
      bestOf: 3,
      points: 21,
      partnerDiscordId: null,
      opponentPartnerDiscordId: null,
      note: null,
    });
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('Challenge sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses doubles without both partners before calling the app', async () => {
    const reply = await send([
      { name: 'opponent', value: OPPONENT },
      { name: 'type', value: 'doubles' },
      { name: 'partner', value: PARTNER },
    ]);
    expect(reply.data.flags).toBe(64);
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('refuses partners on singles, and challenging yourself', async () => {
    await send([{ name: 'opponent', value: OPPONENT }, { name: 'partner', value: PARTNER }]);
    await send([{ name: 'opponent', value: CALLER }]);
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('sends a full doubles challenge', async () => {
    await send([
      { name: 'opponent', value: OPPONENT },
      { name: 'type', value: 'doubles' },
      { name: 'rated', value: false },
      { name: 'best_of', value: 1 },
      { name: 'points', value: 15 },
      { name: 'partner', value: PARTNER },
      { name: 'opponent_partner', value: OPPONENT_PARTNER },
      { name: 'note', value: '  Thursday? ' },
    ]);
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'doubles',
        rated: false,
        bestOf: 1,
        points: 15,
        partnerDiscordId: PARTNER,
        opponentPartnerDiscordId: OPPONENT_PARTNER,
        note: 'Thursday?',
      })
    );
  });

  it('answers not_linked with /link', async () => {
    createChallenge.mockResolvedValue({ ok: false, refusal: 'not_linked' });
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);
    expect(reply.data.content).toContain('/link');
  });

  it('answers feature_off with its own sentence', async () => {
    createChallenge.mockResolvedValue({ ok: false, refusal: 'feature_off' });
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);
    expect(reply.data.content).toContain('switched off');
  });

  it('passes the club rule sentence through', async () => {
    createChallenge.mockResolvedValue({ ok: false, refusal: 'rule', message: 'You already have 3 open challenges' });
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);
    expect(reply.data.content).toBe('You already have 3 open challenges');
  });

  it('names an unlinked opponent without pinging them', async () => {
    createChallenge.mockResolvedValue({ ok: false, refusal: 'opponent_not_linked' });
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);
    expect(reply.data.content).toContain(`<@${OPPONENT}>`);
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
  });

  it('does not claim nothing happened when the app does not answer', async () => {
    createChallenge.mockRejectedValue(new Error('timeout'));
    const reply = await send([{ name: 'opponent', value: OPPONENT }]);
    expect(reply.data.content).toContain("can't tell whether that went through");
  });
});

describe('/challenge report', () => {
  it('sends the parsed games and the duration, as the caller', async () => {
    const reply = await report([
      { name: 'challenge', value: 'challenge-1' },
      { name: 'score', value: '21-15 18-21 21-19' },
      { name: 'duration', value: 45 },
    ]);

    expect(reportChallenge).toHaveBeenCalledWith({
      discordUserId: CALLER,
      challengeId: 'challenge-1',
      games: [{ mine: 21, theirs: 15 }, { mine: 18, theirs: 21 }, { mine: 21, theirs: 19 }],
      durationMinutes: 45,
    });
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('Ada Lovelace must confirm');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a malformed score without calling the app', async () => {
    const reply = await report([
      { name: 'challenge', value: 'challenge-1' },
      { name: 'score', value: '21 to 15' },
      { name: 'duration', value: 45 },
    ]);
    expect(reply.data.flags).toBe(64);
    expect(reportChallenge).not.toHaveBeenCalled();
  });

  it('refuses a missing duration without calling the app', async () => {
    await report([
      { name: 'challenge', value: 'challenge-1' },
      { name: 'score', value: '21-15' },
    ]);
    expect(reportChallenge).not.toHaveBeenCalled();
  });

  it('answers not_participant with its own sentence', async () => {
    reportChallenge.mockResolvedValue({ ok: false, refusal: 'not_participant' });
    const reply = await report([
      { name: 'challenge', value: 'challenge-1' },
      { name: 'score', value: '21-15' },
      { name: 'duration', value: 20 },
    ]);
    expect(reply.data.content).toContain("isn't one of your accepted challenges");
  });
});

describe('the /challenge report picker', () => {
  function pick(value: string, subcommandName = 'report', focusedName = 'challenge') {
    return handleChallengeAutocomplete(
      [{ name: subcommandName, type: 1, options: [{ name: focusedName, value, focused: true }] }],
      CONTEXT
    ) as unknown as Promise<Reply>;
  }

  it('lists the caller\'s open challenges, each name cut to 100 characters', async () => {
    fetchOpenChallenges.mockResolvedValue([
      { id: 'challenge-1', label: `vs ${'A'.repeat(150)}` },
      { id: 'challenge-2', label: 'vs Grace Hopper - 2026-10-02 - Best of 3 to 21' },
    ]);

    const reply = await pick('');

    expect(fetchOpenChallenges).toHaveBeenCalledWith(CALLER);
    expect(reply.type).toBe(8);
    expect(reply.data.choices?.[0]!.name).toHaveLength(100);
    expect(reply.data.choices?.map((choice) => choice.value)).toEqual(['challenge-1', 'challenge-2']);
  });

  it('filters on what was typed', async () => {
    fetchOpenChallenges.mockResolvedValue([
      { id: 'challenge-1', label: 'vs Ada Lovelace - 2026-10-01 - Best of 3 to 21' },
      { id: 'challenge-2', label: 'vs Grace Hopper - 2026-10-02 - Best of 3 to 21' },
    ]);
    const reply = await pick('grace');
    expect(reply.data.choices?.map((choice) => choice.value)).toEqual(['challenge-2']);
  });

  it('answers an empty list when the app fails', async () => {
    fetchOpenChallenges.mockRejectedValue(new Error('timeout'));
    const reply = await pick('');
    expect(reply.data.choices).toEqual([]);
  });
});
