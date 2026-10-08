import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordOfficer } from '@/lib/discord-officer';

export const dynamic = 'force-dynamic';

// May this officer re-apply ONE member's roles now, and is there a member to
// re-apply them to. That is the whole of it.
//
// NOTHING IS WRITTEN TO THE CLUB'S RECORDS HERE, and that is why this route
// takes no `reason` where its force-unlink sibling insists on one. A reason is
// what makes a by-hand edit to a member's record acceptable; this act edits
// nothing and is convergent, so there is no by-hand act to justify. The bot
// still files its own Discord audit entry naming who ran it and about whom.
//
// It is still gated, and on the same capability, because it acts on ANOTHER
// member's Discord roles on their behalf.
//
// ---- WHY THE ABSENT-LINK CASE IS A REFUSAL AND NOT A NO-OP ----
//
// The bot resyncs through syncMembersNow(), and member-sync.ts reads an id that
// is absent from the linked-members roster as "strip everything", deliberately,
// because that is how a tombstone gets cleared for free. So running the resync
// against an account with no link row would not refresh anything: it would be a
// SILENT FULL STRIP the officer did not ask for. Refusing here is what keeps
// that from being one keystroke away.

/** Why the app declined. A closed set; the bot matches it and never prints it. */
type Refusal = 'not_linked' | 'not_permitted' | 'target_not_linked';

/** A 200 carrying a code, for the reason the force-unlink route's header gives. */
function refuse(refusal: Refusal) {
  return NextResponse.json({ ok: false, refusal });
}

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '');

  // `discordUserId` IS THE CALLER, the officer who typed the command. The
  // account being resynced is the separate `targetDiscordUserId`. Swapping the
  // two would ask the app whether the member being resynced may resync
  // themselves, which is the gate inverted.
  const discordUserId = str('discordUserId').trim();
  const targetDiscordUserId = str('targetDiscordUserId').trim();

  if (!discordUserId || !/^\d{5,25}$/.test(targetDiscordUserId)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const officer = await resolveDiscordOfficer(supabase, discordUserId);
  if (!officer.ok) {
    if (officer.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(officer.refusal);
  }

  const { data: target, error: targetError } = await supabase
    .from('player_discord_links')
    .select('player_id, players!inner(full_name)')
    .eq('discord_user_id', targetDiscordUserId)
    .maybeSingle();

  if (targetError) {
    // NAMED, never degraded to "not linked", and this one has teeth beyond the
    // usual: degrading it would refuse a resync for a member who is linked, and
    // send the officer looking for a broken link that is not broken.
    console.error('[discord] force-sync target read failed:', targetError.message);
    return NextResponse.json({ error: 'link_unavailable' }, { status: 503 });
  }

  const targetLink = target as unknown as {
    player_id: string;
    players?: { full_name: string | null } | null;
  } | null;
  if (!targetLink) return refuse('target_not_linked');

  return NextResponse.json({ ok: true, memberName: targetLink.players?.full_name ?? null });
}
