import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which Discord roles members may give THEMSELVES — the ping roles.
//
// WHY THE APP OWNS THIS LIST AT ALL, given that assigning the role is a pure
// Discord operation the bot could do without asking anybody.
//
// Because the alternative is trusting the button. A component interaction
// carries a `custom_id` chosen when the message was posted, and the message
// outlives the configuration: a picker posted in September still has its
// buttons in January, after the role was deleted, renamed, or quietly taken off
// the list. Treating that id as authority means the bot assigns whatever a
// months-old message tells it to. Checking against this table means the answer
// is always current, and a role removed from the picker stops being assignable
// the moment it is removed rather than whenever somebody remembers to delete
// the message.
//
// THE ROLES HERE ARE NOT THE SWEEP'S ROLES, and 00168 enforces that with a
// trigger in both directions rather than leaving it to whoever runs the command.
// A sweep-managed role made self-assignable would be stripped from everyone who
// clicked it at the next nightly reconcile — the button would look broken and
// the sweep would look like it was misbehaving, and neither would be.

interface SelfRoleRow {
  role_id: string;
  label: string;
  emoji: string | null;
  sort_order: number;
}

// Discord renders at most 5 buttons per action row and 5 rows per message.
const MAX_SELF_ROLES = 25;

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  // Read on every button press, so budgeted like /config rather than /members.
  const limited = rateLimit(`discord:self-roles:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) {
    return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });
  }

  const { data, error } = await createServiceRoleClient()
    .from('discord_self_roles')
    .select('role_id, label, emoji, sort_order')
    .eq('guild_id', guildId)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });

  if (error) {
    // NAMED, never degraded to an empty list. Until 00168 is applied this table
    // does not exist, and a failed PostgREST read arrives as `data: null` with
    // an error rather than a throw — so returning `roles: []` here would render
    // an empty picker and read as "nobody has configured any", which is a
    // different problem with a different fix.
    console.error('[discord] self-roles read failed:', error.message);
    return NextResponse.json(
      { error: 'self_roles_unavailable', detail: error.message },
      { status: 503 }
    );
  }

  const rows = (data ?? []) as SelfRoleRow[];

  return NextResponse.json({
    roles: rows.slice(0, MAX_SELF_ROLES).map((r) => ({
      roleId: r.role_id,
      label: r.label,
      emoji: r.emoji,
      sortOrder: r.sort_order,
    })),
    // The bot says so in the picker rather than silently dropping the tail.
    truncated: rows.length > MAX_SELF_ROLES,
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:self-roles:write:${ip}`, 20, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: {
    guildId?: unknown;
    roleId?: unknown;
    label?: unknown;
    emoji?: unknown;
    sortOrder?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const guildId = typeof body.guildId === 'string' ? body.guildId : null;
  const roleId = typeof body.roleId === 'string' ? body.roleId : null;
  const label = typeof body.label === 'string' ? body.label.trim() : null;

  if (!guildId || !roleId || !label) {
    return NextResponse.json({ error: 'guild_role_and_label_required' }, { status: 400 });
  }
  if (label.length > 80) {
    return NextResponse.json({ error: 'label_too_long' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_self_roles')
    .upsert(
      {
        guild_id: guildId,
        role_id: roleId,
        label,
        emoji: typeof body.emoji === 'string' && body.emoji ? body.emoji : null,
        sort_order: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
      },
      { onConflict: 'guild_id,role_id' }
    );

  if (error) {
    // 00168's trigger raises check_violation when the role is one the nightly
    // sweep controls. That is a CONFIGURATION MISTAKE with a specific fix, not
    // a server fault, so it gets its own status and its own message instead of
    // being flattened into "something went wrong".
    if (error.code === '23514' || /sweep-managed/.test(error.message)) {
      return NextResponse.json({ error: 'role_is_sweep_managed' }, { status: 409 });
    }
    console.error('[discord] self-role write failed:', error.message);
    return NextResponse.json(
      { error: 'self_role_write_failed', detail: error.message },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:self-roles:write:${ip}`, 20, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const guildId = params.get('guildId');
  const roleId = params.get('roleId');
  if (!guildId || !roleId) {
    return NextResponse.json({ error: 'guild_and_role_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_self_roles')
    .delete()
    .eq('guild_id', guildId)
    .eq('role_id', roleId);

  if (error) {
    console.error('[discord] self-role delete failed:', error.message);
    return NextResponse.json({ error: 'self_role_delete_failed' }, { status: 503 });
  }

  // Deliberately NOT stripping the role from everyone who already holds it.
  // Taking a ping role off the list means "stop offering this", not "punish
  // the people who took it" — and a mass role-removal triggered by a config
  // edit is exactly the kind of surprise that makes people distrust the bot.
  // The button stops working; existing holders keep it until they click off.
  return NextResponse.json({ ok: true });
}
