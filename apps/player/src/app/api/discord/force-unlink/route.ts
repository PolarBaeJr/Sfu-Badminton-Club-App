import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordOfficer } from '@/lib/discord-officer';

export const dynamic = 'force-dynamic';

// Disconnect ANOTHER member's Discord account, from Discord, on an officer's
// word.
//
// THE ONLY OFFICER-FACING UNLINK THERE IS. The console's Discord panel
// (apps/admin/src/app/players/[id]/discord-link-panel.tsx) links and does not
// unlink, so before this route the only way to detach somebody else's account
// was to force-link it onto a different member. That is why this exists.
//
// WHY NOT api/discord/link/route.ts. That DELETE route unlinks the CALLER and
// carries no capability check at all, on the argument its own comment makes:
// there is no parameter there that could name another member, so the service
// secret is enough. Adding a target parameter to it would convert a caller-only
// route into unlink-anyone behind nothing but that secret. This is a separate
// route with a separate gate for that reason.
//
// ---- THE TWO GATES, AND THE SECOND IS THE REAL ONE ----
//
// The service secret proves the request came from the bot and says nothing
// about who typed the command. The boundary is the capability check in
// resolveDiscordOfficer(), which resolves the CALLER's own club account and
// asks it for `players.discordlink.write`.
//
// ---- THE ORDER OF THE WRITE IS THE SAFETY ARGUMENT ----
//
// The row is deleted HERE and the Discord roles are stripped by the bot
// AFTERWARDS. Reversed, a strip that lands before a delete that fails leaves a
// member with no roles and a live link, and the next sweep puts the roles back,
// so the strip silently undoes itself. In this order a crash straight after the
// delete leaves 00165's tombstone behind and the sweep finishes the job.

/** Why the app declined. A closed set; the bot matches it and never prints it. */
type Refusal = 'not_linked' | 'not_permitted' | 'no_reason' | 'target_not_linked';

// A REFUSAL IS A 200 CARRYING A CODE, on the force-link route's argument: the
// app was reached, it answered clearly, and the answer was a specific no with a
// specific fix. api.ts renders every non-ok status as "couldn't reach the club
// app just now", which is the wrong sentence for all four of these, and a 5xx
// would be a lie in the other direction because nothing is broken.
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

  // `discordUserId` IS THE CALLER, the officer who typed the command. It means
  // that on every other route on this surface and it keeps meaning that here:
  // the account being DISCONNECTED is the separate `targetDiscordUserId`. Two
  // Discord ids in one body is the thing that makes this route different from
  // every other one, and naming the caller anything else is how the two get
  // swapped by somebody reading quickly.
  const discordUserId = str('discordUserId').trim();
  const targetDiscordUserId = str('targetDiscordUserId').trim();

  // VALIDATED RATHER THAN TRUSTED, to the shape link/route.ts already enforces
  // on this table's other delete path. The id arrives from an autocompleted
  // choice value or from a snowflake an officer pasted, so a malformed one is a
  // 400 for the bot rather than advice for the officer.
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

  // AFTER the capability check, and before the target is read. An officer who
  // may do this still has to say why, exactly as the console's panel requires
  // of the opposite act, because the audit row is the whole reason unlinking
  // somebody else by hand is acceptable at all.
  const reason = str('reason').trim();
  if (!reason) return refuse('no_reason');

  // WHO THIS ACCOUNT BELONGS TO, READ BEFORE THE DELETE. After it the player_id
  // is unrecoverable and the audit row would have no target, which is the one
  // field that makes the entry findable on the member's own record.
  const { data: target, error: targetError } = await supabase
    .from('player_discord_links')
    .select('player_id, players!inner(full_name)')
    .eq('discord_user_id', targetDiscordUserId)
    .maybeSingle();

  if (targetError) {
    // NAMED, never degraded to "not linked". Reading a failed PostgREST read as
    // an absent link would tell an officer the account they can see in the
    // picker is not connected to anybody, and then leave it connected.
    console.error('[discord] force-unlink target read failed:', targetError.message);
    return NextResponse.json({ error: 'link_unavailable' }, { status: 503 });
  }

  const targetLink = target as unknown as {
    player_id: string;
    players?: { full_name: string | null } | null;
  } | null;
  if (!targetLink) return refuse('target_not_linked');

  const memberName = targetLink.players?.full_name ?? null;

  // BY DISCORD ID, mirroring link/route.ts, because that is the column 00165's
  // trigger tombstones from. The delete IS the guarantee: the tombstone means
  // the roles come off at the next sweep even if the bot dies in the next
  // millisecond, and the bot's immediate strip is only the fast path.
  const { data: deleted, error: deleteError } = await supabase
    .from('player_discord_links')
    .delete()
    .eq('discord_user_id', targetDiscordUserId)
    .select('discord_user_id');

  if (deleteError) {
    console.error('[discord] force-unlink delete failed:', deleteError.message);
    Sentry.captureException(new Error(`Discord force unlink failed: ${deleteError.message}`), {
      extra: { playerId: targetLink.player_id, actorId: officer.player.id },
    });
    return NextResponse.json({ error: 'force_unlink_failed' }, { status: 503 });
  }

  // ZERO ROWS MEANS ANOTHER OFFICER WON THE RACE between the read above and
  // this delete. Reported as the same refusal an absent link gets, never as a
  // success: claiming an unlink this call did not perform would put an audit row
  // under the wrong officer's name.
  if ((deleted ?? []).length === 0) return refuse('target_not_linked');

  // AUDITED LIKE THE CONSOLE'S WRITES ARE, because the audit log is meant to be
  // the record of a row's history rather than the record of the admin app's
  // activity, and this is the only door this act has.
  //
  // WRITTEN INLINE, and not through logMemberAudit(). That helper pins
  // target_type and target_id to the ACTOR, which is exactly what this act
  // cannot use: the actor is the officer and the target is the member being
  // disconnected, and they are different people. Filing it through the helper
  // would record an officer editing themselves.
  //
  // FAILURE IS REPORTED, NEVER THROWN: the row is already deleted, and losing
  // the record of it must not also lose the officer's reply. THE PLAYER APP HAS
  // NO DEGRADED AUDIT RETRY, unlike the console's logAdminAudit, so a refused
  // insert here loses the WHOLE row and Sentry is the only trace left.
  const { error: auditError } = await supabase.from('audit_logs').insert({
    actor_id: officer.player.id,
    action_type: 'discord_link_force_removed',
    target_type: 'player',
    target_id: targetLink.player_id,
    old_value: { discord_user_id: targetDiscordUserId },
    new_value: { discord_user_id: null },
    reason,
  });

  if (auditError) {
    Sentry.captureException(new Error(`Discord force unlink audit failed: ${auditError.message}`), {
      extra: { playerId: targetLink.player_id, actorId: officer.player.id, source: 'discord' },
    });
  }

  return NextResponse.json({ ok: true, memberName });
}
