import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-server';
import { discordActorStore, resolveDiscordActor } from '@/lib/discord-actor';
import { isAuthorizedDiscordService, discordServiceUnauthorized } from '@/lib/discord-service-auth';
import {
  archiveSession,
  createSession,
  deleteSession,
  getOrCreateSessionCheckinToken,
  rotateSessionCheckinToken,
  updateSession,
} from '@/lib/actions/sessions';
import {
  cancelClubEvent,
  createClubEvent,
  deleteClubEvent,
  updateClubEvent,
} from '@/lib/actions/club-events';

// CONSOLE COMMANDS ON DISCORD: the writes.
//
// Each name runs the console's own server action, unchanged, as the exec whose
// Discord account is linked: the same capability gate, standing checks, audit
// rows and notifications as the button in the console. The zod tuples only
// check the SHAPE of the arguments, and they are strict on purpose: an action
// such as updateSession reads an absent field as "clear it", so a misspelt key
// must be a 400 rather than a blanked column.
//
// The service secret is checked first and is the only way into
// discordActorStore. Answers are the action's own ActionResult under a 200, so
// the bot reads a refusal as a sentence; two refusals are named for it:
// 'not_linked' and 'passkey_required'.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const uuid = z.string().uuid();
const object = z.record(z.unknown());
const reason = z.string().max(1000);
const clockTime = z.string().regex(/^\d{2}:\d{2}$/);
const track = z.enum(['competitive', 'recreational', 'all']);

const sessionFields = {
  name: z.string().max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: clockTime.optional(),
  end_time: clockTime.optional(),
  location: z.string().max(200),
  notes: z.string().max(500).optional(),
  track,
};

const sessionCreateInput = z
  .object({
    ...sessionFields,
    repeat_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    repeat_frequency: z.literal('weekly').optional(),
  })
  .strict();

const sessionUpdateInput = z.object(sessionFields).strict();

// The tuple has already checked the shapes, and each action re-validates its
// own input with the shared schemas, so the call is typed loosely here.
type AnyAction = (...args: unknown[]) => Promise<unknown>;

const ACTIONS: Record<string, { args: z.ZodTypeAny; run: AnyAction }> = {
  createSession: { args: z.tuple([sessionCreateInput]), run: createSession as AnyAction },
  updateSession: { args: z.tuple([uuid, sessionUpdateInput, reason]), run: updateSession as AnyAction },
  archiveSession: { args: z.tuple([uuid, reason]), run: archiveSession as AnyAction },
  deleteSession: { args: z.tuple([uuid, reason]), run: deleteSession as AnyAction },
  getOrCreateSessionCheckinToken: { args: z.tuple([uuid]), run: getOrCreateSessionCheckinToken as AnyAction },
  rotateSessionCheckinToken: { args: z.tuple([uuid]), run: rotateSessionCheckinToken as AnyAction },
  // clubEventSchema is .strict() itself, so the object is checked there.
  createClubEvent: { args: z.tuple([object]), run: createClubEvent as AnyAction },
  updateClubEvent: { args: z.tuple([uuid, object]), run: updateClubEvent as AnyAction },
  cancelClubEvent: { args: z.tuple([uuid, reason]), run: cancelClubEvent as AnyAction },
  deleteClubEvent: { args: z.tuple([uuid]), run: deleteClubEvent as AnyAction },
};

const body = z.object({
  discordUserId: z.string().regex(/^\d{5,25}$/),
  args: z.unknown(),
});

function reply(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const { name } = await params;
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!action) return reply({ error: 'Unknown action' }, 404);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return reply({ error: 'Invalid request' }, 400);
  }
  const parsedBody = body.safeParse(raw);
  if (!parsedBody.success) return reply({ error: 'Invalid request' }, 400);
  const parsedArgs = action.args.safeParse(parsedBody.data.args);
  if (!parsedArgs.success) return reply({ error: 'Invalid request' }, 400);

  const actor = await resolveDiscordActor(parsedBody.data.discordUserId, createAdminClient());
  if (actor === 'unavailable') return reply({ error: 'unavailable' }, 503);
  if (actor === 'not_linked') return reply({ ok: false, refusal: 'not_linked' }, 200);

  const result = (await discordActorStore.run(
    { playerId: actor.playerId, discordUserId: parsedBody.data.discordUserId },
    () => action.run(...(parsedArgs.data as unknown[])),
  )) as { ok: boolean; code?: string };

  // Inside the store the cookie step-up never runs, so AUTH-105 can only be
  // the Discord passkey policy refusing.
  if (!result.ok && result.code === 'AUTH-105') {
    return reply({ ok: false, refusal: 'passkey_required' }, 200);
  }
  return reply(result, 200);
}
