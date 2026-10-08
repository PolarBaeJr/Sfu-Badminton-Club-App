import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// THE CATALOGUE OF ROLES THE SERVER HAS, written by the bot and read by the
// admin console's notify picker.
//
// WHY THIS IS NOT PART OF /api/discord/config. That route's payload feeds
// `registryFromPayload` in the bot, which THROWS on a role name outside
// MANAGED_ROLES, and the ladder in loadConfig turns a throw into a fallback to
// the last good cache and then to env, and with neither into a hard failure that
// takes the sweep, the outbox drain and the announcements tick down with it.
// Putting @Session Pings into that payload would do precisely that. Separate
// route, separate table (00229), one direction of travel.
//
// POST ONLY. Nothing reads this back through the API: the console reads the table
// directly with its own service-role client, and the bot has nothing to do with
// the catalogue once it has posted it.

/** Discord snowflakes. Same shape 00229's CHECK enforces. */
const SNOWFLAKE = /^[0-9]{5,25}$/;

/** Discord's own cap on a role name. Mirrors the CHECK in 00229. */
const NAME_MAX = 100;

/**
 * Discord's per-guild role limit is 250, so the cap is that and not less: a
 * lower one would make a large server's catalogue permanently unwritable rather
 * than merely truncated, which is a picker that silently stops growing.
 */
const MAX_ROLES = 250;

interface CatalogRole {
  roleId: string;
  name: string;
  position?: number;
}

// AUTHORITATIVE PER-GUILD REPLACE, which is the opposite posture to
// /api/discord/config's upsert-only POST, deliberately.
//
// A stale row in the MANAGED MAP is a working mapping: /setup sends what it could
// resolve, and a role it failed to resolve this run must never erase the id that
// has been handing out @Internal since September. A stale row in the CATALOGUE is
// a picker entry pointing at a role that no longer exists, which resolves to a
// mention Discord renders as a dead snowflake.
//
// ONLY FOR GUILDS THE PAYLOAD NAMES, and never as a blanket delete. A bot whose
// role fetch failed posts nothing at all, so the previous catalogue stands rather
// than being wiped by an empty success.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { guildId, roles } = (body ?? {}) as { guildId?: unknown; roles?: unknown };

  // EVERY FIELD IS CHECKED HERE rather than trusted because our own bot sent it,
  // for the reason /api/discord/config gives: the bot builds this payload out of
  // names and ids it read from somebody else's guild, and "the caller is our
  // code" is not the same claim as "the data is ours".
  if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) {
    return NextResponse.json({ error: 'invalid_guild_id' }, { status: 400 });
  }
  if (!Array.isArray(roles)) {
    return NextResponse.json({ error: 'invalid_roles' }, { status: 400 });
  }
  // REFUSED, not treated as "delete everything". Under replace semantics an empty
  // array is the one payload that silently empties the picker, and the honest
  // reading of it is a caller that filtered every role away by mistake. A guild
  // whose roles genuinely cannot be read posts nothing at all.
  if (roles.length === 0) {
    return NextResponse.json({ error: 'no_roles' }, { status: 400 });
  }
  if (roles.length > MAX_ROLES) {
    return NextResponse.json({ error: 'too_many_roles' }, { status: 400 });
  }

  const rows: { guild_id: string; role_id: string; role_name: string; position: number | null }[] = [];
  for (const entry of roles as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'invalid_role' }, { status: 400 });
    }
    const { roleId, name, position } = entry as Partial<CatalogRole>;
    if (typeof roleId !== 'string' || !SNOWFLAKE.test(roleId)) {
      return NextResponse.json({ error: 'invalid_role_id' }, { status: 400 });
    }
    // @everyone shares the guild's own id and cannot be notified through the
    // roles list at all, so a row for it would be a picker entry that rings
    // nobody. 00229 has the same CHECK; this is the one that can say which id.
    if (roleId === guildId) {
      return NextResponse.json({ error: 'role_is_everyone' }, { status: 400 });
    }
    if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_MAX) {
      return NextResponse.json({ error: 'invalid_role_name', detail: roleId }, { status: 400 });
    }
    if (position !== undefined && typeof position !== 'number') {
      return NextResponse.json({ error: 'invalid_position', detail: roleId }, { status: 400 });
    }
    rows.push({
      guild_id: guildId,
      role_id: roleId,
      role_name: name.trim(),
      position: position ?? null,
    });
  }

  const supabase = createServiceRoleClient();

  // UPSERT FIRST, DELETE SECOND. The other order leaves a window in which the
  // console reads an empty catalogue and offers only the club's nine, and the
  // tick that runs it is five minutes wide.
  const written = await supabase
    .from('discord_server_roles')
    .upsert(
      rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })),
      { onConflict: 'guild_id,role_id' },
    );

  if (written.error) {
    // NAMED, never degraded to ok: until 00229 is applied this table does not
    // exist, and a failed PostgREST write arrives as an error rather than a
    // throw. Answering { ok: true } here would leave the bot logging a
    // successful sync forever over a table that was never created.
    console.error('[discord] server-role catalogue write failed:', written.error.message);
    return NextResponse.json(
      { error: 'catalog_write_failed', detail: written.error.message },
      { status: 503 }
    );
  }

  // THE PRUNE IS A READ, A DIFF IN TYPESCRIPT, THEN A DELETE OF WHAT IS ACTUALLY
  // STALE, rather than one `role_id NOT IN (everything just posted)`.
  //
  // The single-statement version is shorter and breaks at size. A PostgREST
  // filter travels in the QUERY STRING, and 250 snowflakes is about 5KB of URL
  // through Kong and the proxy in front of it: exactly the limit the console's
  // own MAX_MAPPING_LOOKUP cap exists for. It would pass on every small server
  // and fail as a 414 on a large one.
  //
  // It also makes the ordinary tick free: nothing changes between most syncs, so
  // the diff comes out empty and no DELETE is issued at all.
  const existing = await supabase
    .from('discord_server_roles')
    .select('role_id')
    // THIS GUILD'S ROWS AND NO OTHER'S. The club may run a second server, and a
    // sync of one must not empty the other.
    .eq('guild_id', guildId);

  if (existing.error) {
    // A FAILED PRUNE IS NOT A FAILED SYNC. Everything the bot could see is
    // already stored; what may be left behind is a role that has gone from
    // Discord, which shows up as a picker entry resolving to a dead mention.
    // Reported so it is visible, and the next tick tries again.
    console.error('[discord] server-role catalogue re-read failed:', existing.error.message);
    return NextResponse.json({ ok: true, guildId, roles: rows.length, pruned: false });
  }

  const posted = new Set(rows.map((r) => r.role_id));
  const stale = ((existing.data ?? []) as { role_id: string }[])
    .map((r) => r.role_id)
    .filter((roleId) => !posted.has(roleId));

  if (stale.length === 0) {
    return NextResponse.json({ ok: true, guildId, roles: rows.length, pruned: true });
  }

  // AND THIS FILTER TRAVELS IN THE QUERY STRING TOO, which reads like the thing
  // the note above just refused. The difference is the BOUND, not the mechanism:
  // `stale` is only what the previous catalogue holds and this sync no longer
  // does, so it is 0 on an ordinary tick and this DELETE is never issued at all.
  // The worst case, a guild that deleted almost all of its roles at once, is the
  // same ~5KB as the single-statement version and is accepted: it happens once,
  // a 414 there leaves rows the NEXT tick prunes with a shorter list, and a
  // `.not(...,'in',...)` would have paid that cost on EVERY sync of a large
  // server instead.
  const removed = await supabase
    .from('discord_server_roles')
    .delete()
    .eq('guild_id', guildId)
    .in('role_id', stale);

  if (removed.error) {
    console.error('[discord] server-role catalogue prune failed:', removed.error.message);
    return NextResponse.json({ ok: true, guildId, roles: rows.length, pruned: false });
  }

  return NextResponse.json({ ok: true, guildId, roles: rows.length, pruned: true });
}
