import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// The one write that runs Discord -> app, and the reason it is allowed to.
//
// Every other role this bot manages is DERIVED: the app decides who is an exec,
// who is competitive, who is session staff, and the sweep pushes that into
// Discord. Reading any of those back would mean anybody with Manage Roles in a
// Discord server could promote themselves inside the club.
//
// @Internal / @Alumni / @External are different, and the club moved them across
// deliberately: they are a statement about who a member IS — an SFU student, a
// graduate, a visitor — not a permission the club grants. Members now pick their
// own in Discord, so the app follows rather than overwrites (roles.ts,
// MEMBERSHIP_ROLES).
//
// WHAT THAT COSTS, STATED PLAINLY SO NOBODY REDISCOVERS IT IN A TOURNAMENT:
// membership_type prices a tournament entry (quoteEntryFee) and decides which
// events a member may enter at all (isMembershipAllowed). A member picking
// @Internal is therefore asserting the student fee and student-only eligibility
// for themselves. That is the club's call, it is the same trust the club already
// places in the paper sign-up sheet, and it is why every change here writes an
// audit row naming Discord as the source — an exec can see it on the member's
// history and correct it in the console, which then holds until the member picks
// again.
//
// NOT A PERMISSION ESCALATION PATH: only membership_type is ever written. Not
// status, not is_exec, not role, not fee_exempt.

const MEMBERSHIP_TYPES = ['internal', 'alumni', 'external'] as const;
type MembershipType = (typeof MEMBERSHIP_TYPES)[number];

function isMembershipType(value: unknown): value is MembershipType {
  return typeof value === 'string' && (MEMBERSHIP_TYPES as readonly string[]).includes(value);
}

interface Update {
  discordUserId: string;
  membershipType: MembershipType;
}

/** Both shapes: one member (the picker button) or many (the nightly sweep). */
function parseUpdates(body: unknown): Update[] | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as { updates?: unknown; discordUserId?: unknown; membershipType?: unknown };

  const list = Array.isArray(raw.updates)
    ? raw.updates
    : [{ discordUserId: raw.discordUserId, membershipType: raw.membershipType }];

  const updates: Update[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') return null;
    const { discordUserId, membershipType } = entry as Record<string, unknown>;
    if (typeof discordUserId !== 'string' || discordUserId === '') return null;
    if (!isMembershipType(membershipType)) return null;
    updates.push({ discordUserId, membershipType });
  }

  // A cap, because this is a service endpoint fed by a sweep over the whole
  // roster and an unbounded body would be one member-by-member UPDATE each.
  if (updates.length === 0 || updates.length > 200) return null;
  return updates;
}

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const updates = parseUpdates(body);
  if (!updates) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // ONE READ FOR THE WHOLE BATCH. The link table is what "if the user linked it"
  // means: an unlinked Discord account resolves to no player and is reported
  // back as skipped rather than failing the batch, because a server full of
  // people who never linked is the normal case, not an error.
  const { data: links, error: linkError } = await supabase
    .from('player_discord_links')
    .select('discord_user_id, player_id, players!inner(id, membership_type)')
    .in(
      'discord_user_id',
      updates.map((u) => u.discordUserId)
    );

  if (linkError) {
    // NAMED, never degraded to "nobody is linked" — a failed PostgREST read
    // arrives as data: null with an error, and treating that as an empty list
    // would report every member skipped and look like a clean no-op.
    console.error('[discord] membership link read failed:', linkError.message);
    return NextResponse.json(
      { error: 'membership_unavailable', detail: linkError.message },
      { status: 503 }
    );
  }

  const linked = new Map<string, { playerId: string; current: string | null }>();
  for (const row of (links ?? []) as unknown as {
    discord_user_id: string;
    player_id: string;
    players: { id: string; membership_type: string | null } | null;
  }[]) {
    linked.set(row.discord_user_id, {
      playerId: row.player_id,
      current: row.players?.membership_type ?? null,
    });
  }

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const update of updates) {
    const link = linked.get(update.discordUserId);
    if (!link) {
      skipped += 1;
      continue;
    }
    // Mirrors the column's own default, and the fallback everywhere else in the
    // app reads a null membership_type as 'internal'. Without it a member whose
    // row predates the column would be "changed" to internal on every sweep,
    // writing an audit row a night for a value that never moved.
    const current = link.current ?? 'internal';
    if (current === update.membershipType) {
      unchanged += 1;
      continue;
    }

    const { error } = await supabase
      .from('players')
      .update({ membership_type: update.membershipType })
      .eq('id', link.playerId);

    if (error) {
      failed += 1;
      Sentry.captureException(
        new Error(`Discord membership write failed: ${error.message}`),
        { extra: { playerId: link.playerId, membershipType: update.membershipType } }
      );
      continue;
    }

    updated += 1;

    // ACTOR IS THE MEMBER, because the member is who did it — they clicked the
    // role. Written the same way the console writes an exec's edit so the two
    // sit in one history, with the reason naming Discord as the route: that is
    // what lets an exec looking at a surprising fee tier see in one line that
    // nobody in the console set it.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      actor_id: link.playerId,
      action_type: 'player_updated',
      target_type: 'player',
      target_id: link.playerId,
      old_value: { membership_type: current },
      new_value: { membership_type: update.membershipType },
      reason: 'Member picked their membership role in Discord',
    });
    if (auditError) {
      // Reported, never thrown. The membership is already written; losing the
      // row that describes it must not also turn a good write into a 503.
      Sentry.captureException(
        new Error(`Discord membership audit failed: ${auditError.message}`),
        { extra: { playerId: link.playerId } }
      );
    }
  }

  return NextResponse.json({ ok: true, updated, unchanged, skipped, failed });
}
