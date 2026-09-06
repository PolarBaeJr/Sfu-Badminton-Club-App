import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  announcementSchema,
  consoleAccessLevelFor,
  parseOrThrow,
  permissionsOf,
  permits,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// File a club announcement from Discord.
//
// THE ONLY WRITE ON THIS SURFACE THAT PUBLISHES SOMETHING THE WHOLE CLUB READS,
// and the only one whose caller is a person rather than a cron tick. Everything
// below follows from that.
//
// TWO INDEPENDENT GATES, and the second is the real one.
//
// The service secret proves the request came from the bot. It says nothing at
// all about who typed the command -- every member's /announce arrives with the
// same bearer token. `default_member_permissions: '0'` on the command hides it
// from the picker, and that is a COMMAND-LIST FILTER: Discord happily executes
// a command a member should not see if a server admin ever grants the role, and
// a bot in a second guild carries no such filter at all. So the caller's Discord
// id is resolved to a club account here, and that account is asked for
// `announcements.create.write` -- the same capability the console's composer
// requires, through the same resolver, so the two cannot drift.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not notify anybody.
//
// The console's publish path fans out in-app bell rows and (optionally) web
// push, and doing that correctly means resolving the audience -- which carries
// 00132's rule that an unfinished signup is never in it. That rule lives in the
// admin app, is the reason a stub once nearly got pushed a notification about a
// club they had not joined, and has no test coverage. Copying it here would put
// a second copy of a push-safety rule in a second app, free to drift; extracting
// it would refactor a live, untested push path so that a Discord command can
// reuse it. Neither is worth it for this.
//
// So a Discord-filed announcement reaches members exactly two ways: it is on the
// website immediately, and the announcements relay posts it into the configured
// channel on its next tick. NOBODY IS PINGED. The bot's reply says so in those
// words, because an exec who believes they have notified the club and has not is
// the one outcome this feature must not produce quietly. `send_push` is written
// FALSE explicitly rather than left to the column's own DEFAULT TRUE (00001):
// the console's list renders "pushed" off that column, and a true there would be
// a claim about a push that never happened.
//
// AUDIENCE IS ALWAYS 'all', and it is not an option on the command. The relay
// only ever posts `target_audience = 'all'` -- a narrower one is skipped as
// `narrow_audience`, deliberately, because a Discord channel is not a viewer and
// cannot have the per-viewer rule applied to it. Combined with the paragraph
// above, a narrow announcement filed from Discord would reach no channel and no
// notification: it would exist only for somebody who happened to open the
// announcements page. Offering the choice would be offering a silently inert
// command, so the choice stays in the console where it works.

/** Long enough for a real notice, inside the schema's own 5000. */
const MAX_BODY = 3500;
const MAX_TITLE = 200;

type Refusal = 'not_linked' | 'not_permitted' | 'no_active_season';

// A REFUSAL IS A 200, and this is a departure worth naming.
//
// api.ts renders every non-ok status as "couldn't reach the club app just now",
// which is exactly the wrong sentence for all three of these: the app was
// reached, it answered clearly, and the answer was a specific no with a specific
// fix. The bot has three bespoke Error subclasses for precisely this problem
// already (AlreadyLinkedError, SweepManagedRoleError, RateLimitedError) and a
// fourth carrying a code would be a fourth. A named refusal in the body keeps
// one code path and makes the mistranslation unreachable.
//
// The status is honest about what happened: nothing was written, and the caller
// is told which of the three reasons applies. A 5xx here would be a lie in the
// other direction -- nothing is broken.
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
  const flag = (key: string) => payload[key] === true;

  const discordUserId = str('discordUserId').trim();
  const title = str('title').trim().slice(0, MAX_TITLE);
  const body = str('body').trim().slice(0, MAX_BODY);
  const rawType = str('type');
  const type = (['info', 'warning', 'urgent', 'event'] as const).includes(
    rawType as 'info' | 'warning' | 'urgent' | 'event'
  )
    ? (rawType as 'info' | 'warning' | 'urgent' | 'event')
    : 'info';

  if (!discordUserId || !title || !body) {
    return NextResponse.json({ error: 'incomplete_announcement' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // The caller, and everything needed to answer "may they".
  //
  // The permission triple is selected WHOLE -- permissionsOf() throws on a row
  // that carries permission_role without both delta columns, rather than
  // resolving somebody wider than they are. Narrowing this select is how that
  // throw gets reached.
  const { data: link, error: linkError } = await supabase
    .from('player_discord_links')
    .select(
      'player_id, players!inner(id, role, is_exec, is_trainer, is_banned, status, ' +
        'active_flag, permission_role, permission_grants, permission_revokes)'
    )
    .eq('discord_user_id', discordUserId)
    .maybeSingle();

  if (linkError) {
    // NAMED, never degraded to "no link". A failed PostgREST read arrives as
    // data:null with an error rather than throwing, and reading that as an
    // unlinked caller would tell an exec to run /link -- which they already
    // have, and which would then refuse them as already linked.
    console.error('[discord] announce link read failed:', linkError.message);
    return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
  }

  // createServiceRoleClient is not generic over Database, so the embedded row
  // arrives untyped. Annotated once, here, at the boundary -- the same shape the
  // members route names for the same join.
  const player = ((link as unknown as { players?: unknown } | null)?.players ?? null) as
    | {
        id: string;
        role: string | null;
        is_exec: boolean | null;
        is_trainer: boolean | null;
        is_banned: boolean | null;
        status: string | null;
        active_flag: boolean | null;
        permission_role: string | null;
        permission_grants: string[] | null;
        permission_revokes: string[] | null;
      }
    | null;

  if (!player) return refuse('not_linked');

  // Standing first, then level -- consoleAccessLevelFor is the composition the
  // console itself enforces, so a banned or suspended exec is refused here for
  // the same reason they cannot open the composer.
  const level = consoleAccessLevelFor(player);
  if (!level) return refuse('not_permitted');
  if (!permits(level, permissionsOf(level, player), 'announcements.create.write')) {
    return refuse('not_permitted');
  }

  // A term-specific announcement belongs to the season being played and retires
  // with it; an evergreen one -- the club rules, the door code -- carries no
  // season at all. 00085's CHECK allows exactly those two shapes.
  //
  // Between terms, with `evergreen` unset, there is nothing to file it against.
  // That is a REACHABLE state rather than a hypothetical, so it is a named
  // refusal the bot renders as a sentence, not a throw the bot renders as
  // "couldn't reach the club app".
  const evergreen = flag('evergreen');
  let seasonId: string | null = null;
  if (!evergreen) {
    const { data: activeSeason, error: seasonError } = await supabase
      .from('seasons')
      .select('id')
      .eq('active_flag', true)
      .maybeSingle();
    if (seasonError) {
      console.error('[discord] announce season read failed:', seasonError.message);
      return NextResponse.json({ error: 'season_unavailable' }, { status: 503 });
    }
    if (!activeSeason?.id) return refuse('no_active_season');
    seasonId = activeSeason.id as string;
  }

  const status = flag('draft') ? 'draft' : 'published';

  const record = {
    title,
    body,
    type,
    target_audience: 'all' as const,
    pinned: flag('pin'),
    send_push: false,
    status,
  };

  // The same schema the console's composer validates against, so a length or an
  // enum can never mean two things in the two apps. Everything above has already
  // been clamped or defaulted, so this is a BACKSTOP rather than the check a
  // member's mistake lands on -- and it is caught rather than allowed to throw,
  // because an uncaught throw here is a 500 the bot renders as "couldn't reach
  // the club app", which would send an exec looking for a network fault over a
  // rule this app is enforcing on purpose.
  try {
    parseOrThrow(announcementSchema, record);
  } catch (error) {
    console.error('[discord] announce rejected by schema:', error);
    return NextResponse.json({ error: 'invalid_announcement' }, { status: 400 });
  }

  const { data: announcement, error: insertError } = await supabase
    .from('announcements')
    .insert({ ...record, season_id: seasonId, all_seasons: evergreen, author_id: player.id })
    .select('id')
    .single();

  if (insertError || !announcement) {
    console.error('[discord] announce insert failed:', insertError?.message ?? 'no row');
    Sentry.captureException(
      new Error(`Discord announcement insert failed: ${insertError?.message ?? 'no row'}`),
      { extra: { playerId: player.id } }
    );
    return NextResponse.json({ error: 'announce_failed' }, { status: 503 });
  }

  // AUDITED LIKE THE CONSOLE'S, because it is the same act by the same kind of
  // person and the audit log is meant to be the record of a row's history rather
  // than the record of the admin app's activity.
  //
  // Written here rather than through logMemberAudit(), which pins target_type to
  // 'player' and the target to the actor: the target of this one is the
  // announcement. Failure is REPORTED, NEVER THROWN -- the announcement is
  // already filed, and losing the row that describes it must not also lose the
  // exec's reply.
  const { error: auditError } = await supabase.from('audit_logs').insert({
    actor_id: player.id,
    action_type: 'announcement_created',
    target_type: 'announcement',
    target_id: announcement.id,
    new_value: { ...record, season_id: seasonId, all_seasons: evergreen, source: 'discord' },
    reason: 'Filed from Discord with /announce',
  });
  if (auditError) {
    Sentry.captureException(new Error(`Discord announcement audit failed: ${auditError.message}`), {
      extra: { announcementId: announcement.id, playerId: player.id },
    });
  }

  return NextResponse.json({ ok: true, announcementId: announcement.id, status });
}
