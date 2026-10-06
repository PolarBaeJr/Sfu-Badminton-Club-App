import { describe, it, expect, vi, beforeEach } from 'vitest';

// Discord /signup. Nothing reaches GoTrue until every required answer is in
// the draft, and nothing is created until the code verifies. GoTrue, the
// onboarding body and the bot sync are all mocked; the tables are an in-memory
// stand-in that understands the handful of PostgREST calls the route makes.

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

let tables: Record<string, Row[]> = {};
let failTable: string | null = null;

function parseOr(expression: string): Filter {
  const clauses = expression.split(',').map((clause) => {
    const [column, op, ...rest] = clause.split('.');
    const value = rest.join('.');
    return (row: Row) => {
      const cell = row[column!];
      if (op === 'is' && value === 'null') return cell === null || cell === undefined;
      if (op === 'lt') return cell !== null && cell !== undefined && String(cell) < value;
      if (op === 'eq') return String(cell) === value;
      throw new Error(`fake db: unsupported or clause ${clause}`);
    };
  });
  return (row) => clauses.some((clause) => clause(row));
}

function query(table: string) {
  const filters: Filter[] = [];
  let operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  let payload: Row | Row[] | null = null;
  let returning = false;
  let countHead = false;

  const run = () => {
    if (failTable === table) return { data: null, error: { message: `${table} is down` }, count: null };
    const rows = (tables[table] ??= []);
    const matches = () => rows.filter((row) => filters.every((filter) => filter(row)));
    if (operation === 'insert') {
      for (const row of [payload].flat() as Row[]) rows.push({ ...row });
      return { data: null, error: null, count: null };
    }
    if (operation === 'upsert') {
      const row = payload as Row;
      const index = rows.findIndex((existing) => existing.discord_user_id === row.discord_user_id);
      if (index >= 0) rows[index] = { ...row };
      else rows.push({ ...row });
      return { data: null, error: null, count: null };
    }
    if (operation === 'update') {
      const hit = matches();
      for (const row of hit) Object.assign(row, payload);
      return { data: returning ? hit.map((row) => ({ ...row })) : null, error: null, count: null };
    }
    if (operation === 'delete') {
      const hit = new Set(matches());
      tables[table] = rows.filter((row) => !hit.has(row));
      return { data: null, error: null, count: null };
    }
    const hit = matches();
    return { data: countHead ? null : hit.map((row) => ({ ...row })), error: null, count: hit.length };
  };

  const builder = {
    select(_columns?: string, options?: { count?: string; head?: boolean }) {
      if (operation === 'select') countHead = !!options?.head;
      else returning = true;
      return builder;
    },
    insert(rows: Row | Row[]) {
      operation = 'insert';
      payload = rows;
      return builder;
    },
    upsert(row: Row) {
      operation = 'upsert';
      payload = row;
      return builder;
    },
    update(changes: Row) {
      operation = 'update';
      payload = changes;
      return builder;
    },
    delete() {
      operation = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    gte(column: string, value: string) {
      filters.push((row) => String(row[column]) >= value);
      return builder;
    },
    lt(column: string, value: string) {
      filters.push((row) => String(row[column]) < value);
      return builder;
    },
    or(expression: string) {
      filters.push(parseOr(expression));
      return builder;
    },
    async maybeSingle() {
      const result = run();
      const rows = (result.data ?? []) as Row[];
      return { data: rows[0] ?? null, error: result.error };
    },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return builder;
}

const service = { from: (table: string) => query(table) };

const signInWithOtp = vi.fn(async (_args: unknown) => ({ data: {}, error: null as { message: string; status?: number } | null }));
let otpOutcome: (type: string) => { message: string } | null = () => null;
const verifyOtp = vi.fn(async ({ type }: { email: string; token: string; type: string }) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const error = otpOutcome(type);
  if (error) return { data: { session: null, user: null }, error };
  return {
    data: { session: { access_token: 'member-access-token' }, user: { id: 'user-1', email: 'new@example.com' } },
    error: null,
  };
});
const signOut = vi.fn(async (_args: unknown) => ({ error: null }));
const memberRpc = vi.fn(async (_name: string, _params: unknown) => ({ data: null, error: null as { message: string } | null }));
const memberClientTokens: string[] = [];

vi.mock('@/lib/discord-signup-auth', () => ({
  createSignupAuthClient: () => ({ auth: { signInWithOtp, verifyOtp, signOut } }),
  createSignupMemberClient: (token: string) => {
    memberClientTokens.push(token);
    return { rpc: memberRpc };
  },
}));

vi.mock('@/lib/supabase-server', () => ({ createServiceRoleClient: () => service }));

let onboardingError: Error | null = null;
const completeOnboardingCore = vi.fn(
  async (_client: unknown, user: { id: string }, data: Row, _options: { userAgent: string | null }) => {
    if (onboardingError) throw onboardingError;
    tables.players!.push({ id: 'player-new', user_id: user.id, status: 'pending_approval', onboarding_completed: true, ...data });
    return { playerId: 'player-new' };
  },
);
vi.mock('@/lib/onboarding-core', () => ({ completeOnboardingCore }));

const syncDiscordMembers = vi.fn(async (_ids: string[], _reason: string) => true);
vi.mock('@/lib/discord-link', () => ({
  mintDiscordLinkToken: vi.fn(async () => ({ ok: true, token: 'link-token', expiresAt: new Date() })),
  syncDiscordMembers,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { hashDiscordLinkToken, LEGAL_DOCUMENT_ORDER } = await import('@badminton/shared');
const { versionTag } = await import('@/lib/discord-signup');
const { POST } = await import('../route');

const ME = '222222222';

function post(body: Row, auth = 'Bearer test-secret') {
  return POST(
    new Request('http://localhost/api/discord/signup', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ discordUserId: ME, ...body }),
    }),
  );
}

async function step(body: Row) {
  const response = await post(body);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ok: boolean;
    refusal?: string;
    message?: string;
    screen?: Row & { kind: string; step?: string; document?: string; versionTag?: string; choices?: { value: string; label: string }[] };
  };
}

const DETAILS = {
  action: 'details',
  email: 'New@Example.com ',
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayName: '',
  phone: '',
};

function documents() {
  return LEGAL_DOCUMENT_ORDER.map((document) => ({ document, version: `${document}-v1`, content: `The ${document} text.` }));
}

function draft() {
  return tables.discord_signup_drafts!.find((row) => row.discord_user_id === ME);
}

async function acceptEverything() {
  let result = await step({ action: 'events', answer: 'open' });
  result = await step({ action: 'tier', tier: 'intermediate' });
  for (const document of LEGAL_DOCUMENT_ORDER) {
    expect(result.screen).toMatchObject({ kind: 'document', document });
    result = await step({ action: 'accept', document, versionTag: result.screen!.versionTag });
  }
  expect(result.screen).toMatchObject({ kind: 'choice', step: 'age' });
  return step({ action: 'age' });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  tables = {
    discord_signup_drafts: [],
    discord_signup_attempts: [],
    legal_documents: documents(),
    platform_settings: [],
    player_discord_links: [],
    players: [],
  };
  failTable = null;
  otpOutcome = () => null;
  onboardingError = null;
  memberClientTokens.length = 0;
  signInWithOtp.mockClear();
  verifyOtp.mockClear();
  signOut.mockClear();
  memberRpc.mockClear();
  completeOnboardingCore.mockClear();
  syncDiscordMembers.mockClear();
});

describe('POST /api/discord/signup', () => {
  it('refuses a request without the service secret', async () => {
    const response = await post(DETAILS, 'Bearer wrong');
    expect(response.status).toBe(401);
  });

  it('refuses a Discord account that is already linked', async () => {
    tables.player_discord_links!.push({ discord_user_id: ME, player_id: 'someone' });
    expect(await step(DETAILS)).toMatchObject({ ok: false, refusal: 'already_linked' });
    expect(draft()).toBeUndefined();
  });

  it('starts a draft with the address lowercased and asks the events question first', async () => {
    const result = await step(DETAILS);
    expect(result.screen).toMatchObject({ kind: 'choice', step: 'events', prompt: 'Which events do you play in tournaments?' });
    expect(result.screen!.choices!.map((choice) => choice.label)).toEqual(["Men's", "Women's", 'Open events only']);
    expect(draft()).toMatchObject({ email: 'new@example.com', gender_answered: false, last_name: 'Lovelace' });
  });

  it('requires a last name', async () => {
    expect(await step({ ...DETAILS, lastName: ' ' })).toMatchObject({ ok: false, refusal: 'invalid', message: 'Last name is required' });
  });

  it('a second /signup starts clean', async () => {
    await step(DETAILS);
    await acceptEverything();
    await step(DETAILS);
    expect(draft()).toMatchObject({ gender_answered: false, accepted: {}, age_attestation: false, skill_tier: null });
  });

  it('stores Open events only as NULL, answered', async () => {
    await step(DETAILS);
    await step({ action: 'events', answer: 'open' });
    expect(draft()).toMatchObject({ gender_answered: true, competition_category: null });
    await step({ action: 'events', answer: 'womens' });
    expect(draft()).toMatchObject({ gender_answered: true, competition_category: 'womens' });
  });

  it('Cancel on the waiver deletes the draft and never sends a code', async () => {
    await step(DETAILS);
    await step({ action: 'events', answer: 'mens' });
    let result = await step({ action: 'tier', tier: 'beginner' });
    for (const document of ['terms_of_use', 'privacy_policy']) {
      result = await step({ action: 'accept', document, versionTag: result.screen!.versionTag });
    }
    expect(result.screen).toMatchObject({ kind: 'document', document: 'waiver' });
    expect(await step({ action: 'cancel' })).toMatchObject({ ok: true, screen: { kind: 'cancelled', codeSent: false } });
    expect(draft()).toBeUndefined();
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(tables.players).toEqual([]);
  });

  it('sends the code only after the consent answer, either answer', async () => {
    await step(DETAILS);
    const age = await acceptEverything();
    expect(age.screen).toMatchObject({ kind: 'choice', step: 'consent' });
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(await step({ action: 'consent', consent: false })).toMatchObject({ ok: true, screen: { kind: 'code_sent' } });
    expect(signInWithOtp).toHaveBeenCalledWith({ email: 'new@example.com', options: { shouldCreateUser: true } });
    expect(draft()).toMatchObject({ media_consent: false, send_count: 1 });
  });

  describe('a code is never sent while anything required is missing', () => {
    async function readyDraft() {
      await step(DETAILS);
      await acceptEverything();
      await step({ action: 'consent', consent: true });
      signInWithOtp.mockClear();
      Object.assign(draft()!, { code_sent_at: null, send_count: 0 });
    }

    for (const document of ['waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy']) {
      it(`refuses without the ${document}`, async () => {
        await readyDraft();
        const accepted = { ...(draft()!.accepted as Row) };
        delete accepted[document];
        draft()!.accepted = accepted;
        expect(await step({ action: 'resend' })).toMatchObject({ ok: true, screen: { kind: 'document', document } });
        expect(signInWithOtp).not.toHaveBeenCalled();
      });
    }

    it('refuses without the age line', async () => {
      await readyDraft();
      draft()!.age_attestation = false;
      expect(await step({ action: 'resend' })).toMatchObject({ screen: { kind: 'choice', step: 'age' } });
      expect(signInWithOtp).not.toHaveBeenCalled();
    });

    it('refuses without the events answer', async () => {
      await readyDraft();
      draft()!.gender_answered = false;
      expect(await step({ action: 'resend' })).toMatchObject({ screen: { kind: 'choice', step: 'events' } });
      expect(signInWithOtp).not.toHaveBeenCalled();
    });

    it('refuses without a last name', async () => {
      await readyDraft();
      draft()!.last_name = '';
      expect(await step({ action: 'resend' })).toMatchObject({ ok: false, refusal: 'incomplete' });
      expect(signInWithOtp).not.toHaveBeenCalled();
    });

    it('refuses without the skill level', async () => {
      await readyDraft();
      draft()!.skill_tier = null;
      expect(await step({ action: 'resend' })).toMatchObject({ screen: { kind: 'choice', step: 'tier' } });
      expect(signInWithOtp).not.toHaveBeenCalled();
    });
  });

  it('shows a document again when its version changed before Accept', async () => {
    await step(DETAILS);
    await step({ action: 'events', answer: 'open' });
    const first = await step({ action: 'tier', tier: 'advanced' });
    tables.legal_documents![0]!.version = 'terms_of_use-v2';
    const result = await step({ action: 'accept', document: 'terms_of_use', versionTag: first.screen!.versionTag });
    expect(result.screen).toMatchObject({ kind: 'document', document: 'terms_of_use', page: 0, versionTag: versionTag('terms_of_use-v2') });
    expect(draft()!.accepted).toEqual({});
  });

  it('pages a long document and keeps every page inside an embed', async () => {
    const paragraph = 'x'.repeat(1500);
    tables.legal_documents![0]!.content = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    await step(DETAILS);
    await step({ action: 'events', answer: 'open' });
    const first = await step({ action: 'tier', tier: 'advanced' });
    expect(first.screen).toMatchObject({ kind: 'document', page: 0, pageCount: 3 });
    const last = await step({ action: 'page', document: 'terms_of_use', page: 2 });
    expect(last.screen).toMatchObject({ page: 2, pageCount: 3 });
    expect((last.screen!.text as string).length).toBeLessThanOrEqual(4000);
  });

  it('answers a timed-out draft with timed_out', async () => {
    await step(DETAILS);
    draft()!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await step({ action: 'events', answer: 'open' })).toMatchObject({ ok: false, refusal: 'timed_out' });
    expect(draft()).toBeUndefined();
  });

  describe('rate limits', () => {
    it('three sign-ups a day per Discord account, Cancel or not', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await step(DETAILS);
        await step({ action: 'cancel' });
      }
      expect(await step(DETAILS)).toMatchObject({ ok: false, refusal: 'rate_limited' });
    });

    it('one code a minute per draft', async () => {
      await step(DETAILS);
      await acceptEverything();
      await step({ action: 'consent', consent: false });
      expect(await step({ action: 'resend' })).toMatchObject({ ok: false, refusal: 'rate_limited' });
      expect(signInWithOtp).toHaveBeenCalledTimes(1);
    });

    it('three codes an hour per address', async () => {
      await step(DETAILS);
      await acceptEverything();
      await step({ action: 'consent', consent: false });
      for (let resend = 0; resend < 2; resend++) {
        draft()!.code_sent_at = new Date(Date.now() - 61_000).toISOString();
        expect(await step({ action: 'resend' })).toMatchObject({ ok: true, screen: { kind: 'code_sent' } });
      }
      draft()!.code_sent_at = new Date(Date.now() - 61_000).toISOString();
      expect(await step({ action: 'resend' })).toMatchObject({ ok: false, refusal: 'rate_limited' });
      expect(signInWithOtp).toHaveBeenCalledTimes(3);
      expect(tables.discord_signup_attempts!.some((row) => String(row.email_digest).includes('@'))).toBe(false);
    });

    it('five wrong codes delete the draft', async () => {
      await step(DETAILS);
      await acceptEverything();
      await step({ action: 'consent', consent: false });
      otpOutcome = () => ({ message: 'Token has expired or is invalid' });
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await step({ action: 'verify', code: '000000' })).toMatchObject({ refusal: 'wrong_code' });
      }
      expect(await step({ action: 'verify', code: '000000' })).toMatchObject({ refusal: 'too_many_attempts' });
      expect(draft()).toBeUndefined();
    });
  });

  describe('verify', () => {
    async function codeSent(consent: boolean) {
      await step(DETAILS);
      await acceptEverything();
      await step({ action: 'consent', consent });
    }

    it('makes the account through the shared onboarding body, as Discord', async () => {
      await codeSent(false);
      const result = await step({ action: 'verify', code: '123456' });
      expect(result).toMatchObject({ ok: true, screen: { kind: 'done', approved: false, linked: true } });
      expect(completeOnboardingCore).toHaveBeenCalledTimes(1);
      const [client, user, data, options] = completeOnboardingCore.mock.calls[0]!;
      expect(client).toEqual({ rpc: memberRpc });
      expect(user).toMatchObject({ id: 'user-1' });
      expect(data).toMatchObject({
        first_name: 'Ada',
        last_name: 'Lovelace',
        event_category: 'open',
        waiver_accepted: true,
        code_of_conduct_accepted: true,
        terms_accepted: true,
        age_attestation: true,
        passkey_setup: 'unsupported',
        skill_tier: 'intermediate',
      });
      expect(options.userAgent).toBe('Discord /signup');
      expect(memberClientTokens).toEqual(['member-access-token']);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(draft()).toBeUndefined();
    });

    it('tries the signup token type first, then recovery', async () => {
      await codeSent(false);
      otpOutcome = (type) => (type === 'signup' ? { message: 'Token has expired or is invalid' } : null);
      await step({ action: 'verify', code: '123456' });
      expect(verifyOtp.mock.calls.map(([args]) => args.type)).toEqual(['signup', 'recovery']);
      expect(completeOnboardingCore).toHaveBeenCalledTimes(1);
    });

    it('writes the events answer through the shared body', async () => {
      await step(DETAILS);
      await step({ action: 'events', answer: 'womens' });
      let result = await step({ action: 'tier', tier: 'beginner' });
      for (const document of LEGAL_DOCUMENT_ORDER) {
        result = await step({ action: 'accept', document, versionTag: result.screen!.versionTag });
      }
      await step({ action: 'age' });
      await step({ action: 'consent', consent: false });
      await step({ action: 'verify', code: '123456' });
      expect(completeOnboardingCore.mock.calls[0]![2]).toMatchObject({ event_category: 'womens' });
    });

    it('No thanks never calls set_my_media_consent', async () => {
      await codeSent(false);
      await step({ action: 'verify', code: '123456' });
      expect(memberRpc.mock.calls.map(([name]) => name)).not.toContain('set_my_media_consent');
    });

    it('I consent calls set_my_media_consent(true) as the member', async () => {
      await codeSent(true);
      await step({ action: 'verify', code: '123456' });
      expect(memberRpc).toHaveBeenCalledWith('set_my_media_consent', { p_consent: true });
    });

    it('links through consume_discord_link_token as the member, then syncs roles', async () => {
      await codeSent(false);
      await step({ action: 'verify', code: '123456' });
      expect(memberRpc).toHaveBeenCalledWith('consume_discord_link_token', {
        p_token_hash: await hashDiscordLinkToken('link-token'),
      });
      expect(syncDiscordMembers).toHaveBeenCalledWith([ME], 'linked');
      expect(tables.player_discord_links).toEqual([]);
    });

    it('refuses an address that already has an onboarded account, and creates nothing', async () => {
      await codeSent(false);
      tables.players!.push({ id: 'player-old', user_id: 'user-1', onboarding_completed: true, status: 'competitive' });
      expect(await step({ action: 'verify', code: '123456' })).toMatchObject({ ok: false, refusal: 'existing_account' });
      expect(completeOnboardingCore).not.toHaveBeenCalled();
      expect(memberRpc).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalled();
      expect(draft()).toBeUndefined();
    });

    it('a document that changed after the code was sent is shown again, and the code is not spent', async () => {
      await codeSent(false);
      tables.legal_documents![2]!.version = 'waiver-v2';
      const result = await step({ action: 'verify', code: '123456' });
      expect(result.screen).toMatchObject({ kind: 'document', document: 'waiver' });
      expect(String(result.screen!.notice)).toContain('changed');
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(completeOnboardingCore).not.toHaveBeenCalled();
    });

    it('a double submit completes once', async () => {
      await codeSent(false);
      const results = await Promise.all([
        step({ action: 'verify', code: '123456' }),
        step({ action: 'verify', code: '123456' }),
      ]);
      expect(completeOnboardingCore).toHaveBeenCalledTimes(1);
      expect(results.map((result) => result.refusal ?? result.screen?.kind).sort()).toEqual(['done', 'in_progress']);
    });

    it('a wrong code releases the claim', async () => {
      await codeSent(false);
      otpOutcome = () => ({ message: 'Token has expired or is invalid' });
      expect(await step({ action: 'verify', code: '123456' })).toMatchObject({ refusal: 'wrong_code' });
      expect(draft()).toMatchObject({ completing_at: null, verify_attempts: 1 });
    });

    it('a failed table read is a 503, not a refusal', async () => {
      await codeSent(false);
      failTable = 'legal_documents';
      const response = await post({ action: 'verify', code: '123456' });
      expect(response.status).toBe(503);
    });
  });
});
