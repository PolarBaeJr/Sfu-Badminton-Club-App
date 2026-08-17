// The suppression list is the gate sender.ts's own comment calls "the gate that
// must never fail open". These assert that it does not.
//
// Resend is mocked, so no test here can put mail in front of anybody. That is
// deliberate rather than incidental: leaving RESEND_API_KEY unset would make
// these pass through a completely different code path (the throw in sendEmail)
// and prove nothing about the gate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

type Table = 'email_suppressions' | 'players';
type Answer = { data: unknown; error: { message: string } | null };
const answers: Record<Table, Answer> = {
  email_suppressions: { data: null, error: null },
  players: { data: null, error: null },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: Table) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => answers[table] }),
      }),
    }),
  }),
}));

async function loadSender() {
  // Fresh module each time: sender.ts memoises both the Resend and the
  // service-role client in module scope.
  vi.resetModules();
  return import('../email/sender');
}

describe('sendCategoryEmail suppression gate', () => {
  beforeEach(() => {
    send.mockClear();
    answers.email_suppressions = { data: null, error: null };
    answers.players = { data: null, error: null };
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_PLAYER_URL', 'https://player.test');
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not send when the address is suppressed', async () => {
    answers.email_suppressions = { data: { email: 'x@sfu.ca' }, error: null };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@sfu.ca', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: false, reason: 'suppressed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the suppression read errors', async () => {
    // A failed PostgREST read arrives as `data: null` with an error, never as a
    // throw. Discarding the error makes `blocked` falsy and mails somebody who
    // hard-bounced or filed a spam complaint — silently.
    answers.email_suppressions = { data: null, error: { message: 'JWT expired' } };
    const { sendChallengeReceivedEmail } = await loadSender();

    await expect(
      sendChallengeReceivedEmail('x@sfu.ca', 'Opponent', 'singles', 'ladder', 'c1'),
    ).rejects.toThrow(/suppression/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('still sends when nothing is suppressed and the category is on', async () => {
    answers.players = { data: { notification_preferences: { email_challenges: true } }, error: null };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@sfu.ca', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the preference read failing OPEN, as documented', async () => {
    // Deliberately the opposite call from the suppression read: a preference
    // lookup that misses must not silence a member's mail. Asserted so the
    // suppression fix is not later "tidied" into this one too.
    answers.players = { data: null, error: { message: 'JWT expired' } };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@sfu.ca', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
