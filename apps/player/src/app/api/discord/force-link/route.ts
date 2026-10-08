import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  consoleAccessLevelFor,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  permissionsOf,
  permits,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Attach a Discord account to a club member, from Discord, on an officer's word.
//
// THE SECOND DOOR TO ONE ACT. The first is the console panel
// (apps/admin/src/lib/actions/players.ts:739-921), and everything about what
// this act MEANS is argued there: why an officer needs it at all, why the write
// is one upsert, why the displaced account's id goes in the audit reason. This
// file is the same act reached by somebody standing in Discord rather than in a
// browser, and the two halves are DELIBERATELY DUPLICATED rather than extracted.
//
// WHY NOT EXTRACTED: discordForceLinkFacts is not pure. It takes a Supabase
// client and does four reads, and the two apps' clients are different objects
// with different generics, so sharing it would mean either a client-agnostic
// wrapper or moving the reads out of the shared piece until nothing shared is
// left. What is shared instead is the SEMANTICS, and the cost of that choice is
// real: THE TWO MUST MOVE TOGETHER. A change to the write shape, the conflict
// rule or the audit row here is a change there.
//
// ---- THE TWO GATES, AND THE SECOND IS THE REAL ONE ----
//
// The service secret proves the request came from the bot. It says nothing about
// who typed the command: every member's slash command arrives with the same
// bearer token. `default_member_permissions: '0'` on /forcelink hides it from
// the picker, and that is a COMMAND-LIST FILTER rather than authorization.
// Discord will happily execute a command a member should not see if a server
// admin ever grants the role, and the bot in a second guild carries no such
// filter at all. So the CALLER'S Discord id is resolved to a club account here
// and that account is asked for `players.discordlink.write`: the same capability
// the console's panel requires, through the same resolver, so the two cannot
// drift.
//
// ---- WHAT THIS DOES THAT THE CONSOLE CANNOT ----
//
// Nothing, in the database. The bot's handler additionally strips the displaced
// account's club roles immediately, because the bot holds a Discord token and
// the admin app does not. That is a courtesy on top of the guarantee: 00165's
// trigger tombstones the displaced account, so the roles come off at the next
// sweep whatever the bot manages.

/** Why the app declined. A closed set; the bot matches it and never prints it. */
type Refusal =
  | 'not_linked'
  | 'not_permitted'
  | 'no_such_member'
  | 'already_linked_elsewhere'
  | 'no_reason';

// A REFUSAL IS A 200, and this is a departure worth naming.
//
// api.ts renders every non-ok status as "couldn't reach the club app just now",
// which is exactly the wrong sentence for all five of these: the app was
// reached, it answered clearly, and the answer was a specific no with a specific
// fix. The bot has three bespoke Error subclasses for precisely this problem
// already (AlreadyLinkedError, SweepManagedRoleError, RateLimitedError) and a
// fourth carrying a code would be a fourth. A named refusal in the body keeps
// one code path and makes the mistranslation unreachable.
//
// The status is honest about what happened: nothing was written, and the caller
// is told which of the five reasons applies. A 5xx here would be a lie in the
// other direction, because nothing is broken.
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
  // that on every other route on this surface (announce/route.ts:101) and it
  // keeps meaning that here: the account being ATTACHED is the separate
  // `targetDiscordUserId`. Two Discord ids in one body is the thing that makes
  // this route different from every other one, and naming the caller anything
  // else is how the two get swapped by somebody reading quickly.
  const discordUserId = str('discordUserId').trim();
  const targetDiscordUserId = str('targetDiscordUserId').trim();

  // VALIDATED RATHER THAN TRUSTED, to the shape link/route.ts:29-31 already
  // enforces on this table's other write path.
  //
  // The console answers a malformed id with a human sentence about Settings,
  // Advanced, Developer Mode and Copy User ID (players.ts:745-750). THERE IS NO
  // BOT EQUIVALENT OF THAT SENTENCE AND NONE IS WANTED: this id arrives from a
  // Discord USER option, so the picker produced it and nobody typed it. A
  // malformed one means the bot sent something wrong, which is a 400 for the
  // bot rather than advice for the officer.
  if (!discordUserId || !/^\d{5,25}$/.test(targetDiscordUserId)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // The caller, and everything needed to answer "may they".
  //
  // The permission triple is selected WHOLE: permissionsOf() throws on a row
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
    // unlinked caller would tell an exec to run /link, which they already have,
    // and which would then refuse them as already linked.
    console.error('[discord] force-link caller read failed:', linkError.message);
    return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
  }

  // createServiceRoleClient is not generic over Database, so the embedded row
  // arrives untyped. Annotated once, here, at the boundary: the same shape the
  // announce route names for the same join.
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

  // THE CALLER'S OWN LINK IS THE ONLY CLUB IDENTITY THE BOT HAS.
  //
  // Gate 2 resolves the caller by their Discord id (commands.ts:88-95), so an
  // exec whose own Discord account is not connected has no club account for the
  // capability check to ask about, and no amount of Discord permission changes
  // that. The consequence is worth stating plainly because it is the first
  // thing somebody will try: /FORCELINK CAN NEVER BE THE RECOVERY PATH FOR AN
  // UNLINKED EXEC FIXING THEMSELVES. It is only ever a linked exec fixing
  // somebody else. An officer locked out of their own link uses /link, or asks
  // another officer, or uses the console panel, which authenticates through a
  // browser session rather than through a Discord id.
  if (!player) return refuse('not_linked');

  // Standing first, then level: consoleAccessLevelFor is the composition the
  // console itself enforces, so a banned or suspended exec is refused here for
  // the same reason they cannot open the panel.
  const level = consoleAccessLevelFor(player);
  if (!level) return refuse('not_permitted');
  if (!permits(level, permissionsOf(level, player), 'players.discordlink.write')) {
    return refuse('not_permitted');
  }

  // AFTER the capability check, and before the handle is resolved. An officer
  // who may do this still has to say why, exactly as the console's panel
  // requires, because the audit row is the whole reason a by-hand link is
  // acceptable at all.
  const reason = str('reason').trim();
  if (!reason) return refuse('no_reason');

  // ---- THE TARGET MEMBER ----
  //
  // NORMALISED THE WAY discord-profile.ts:587 DOES, then bounded by the shared
  // handle length before any read, so nothing outside the shape
  // players_handle_shape_check allows (00092: `^[a-z][a-z0-9_]{2,19}$`) costs a
  // query. An out-of-bounds handle misses with the SAME code a genuine absence
  // does, so the caller cannot tell a refused shape from an absent member.
  const wanted = str('handle').trim().replace(/^@/, '').toLowerCase();
  if (wanted.length < HANDLE_MIN_LENGTH || wanted.length > HANDLE_MAX_LENGTH) {
    return refuse('no_such_member');
  }

  // THIS READS players.handle DIRECTLY, AND IT IS THE ONE PLACE ON THIS SURFACE
  // THAT DOES. It is a deliberate divergence from the privacy invariant at
  // discord-profile.ts:516-524, so here is the whole argument.
  //
  // That invariant exists because /profile's handle option feeds an ANONYMOUS
  // route that mints a permanently cached public PNG: a member who is off the
  // ladder (hidden by their own setting, suspended, or not yet approved) must
  // not be findable by anybody typing handles at a bot. Reading the ladder is
  // what makes that true.
  //
  // None of those properties holds here. The act is keyed to ONE OFFICER
  // holding an admin-granted capability, checked above; the reply is ephemeral;
  // nothing public is minted. And the capability exists precisely FOR THE
  // MEMBER WHO CANNOT WALK /link, who is very often pending_approval with no
  // ladder row at all. Resolving through the ladder would make the feature
  // unable to do the only job it was built for: it would refuse exactly the
  // members it is for, and report them as nonexistent while they sat in the
  // console's own list.
  //
  // THE ORDERING ABOVE IS PART OF THIS. The capability check is deliberately
  // above this lookup, not below it. Reversed, `no_such_member` becomes a
  // handle-existence oracle for members the ladder deliberately hides, readable
  // by anyone the service secret admits, which is a strictly wider disclosure
  // than the invariant this diverges from was protecting.
  //
  // `.eq`, NOT `.ilike`. lower(handle) is UNIQUE (00092:189-190) and the CHECK
  // above makes every stored handle lowercase, so plain equality against a
  // lowercased needle IS the case-insensitive match. An ilike would additionally
  // treat `_` as a single-character wildcard, and `_` is legal in a handle: `a_b`
  // would match `axb` and force-link the wrong member.
  const { data: target, error: targetError } = await supabase
    .from('players')
    .select('id, full_name')
    .eq('handle', wanted)
    .maybeSingle();

  if (targetError) {
    // Named for the reason the caller read is: degrading a failed read to
    // "no such member" would send an officer looking for a typo in a handle
    // that is sitting in the console in front of them.
    console.error('[discord] force-link member read failed:', targetError.message);
    return NextResponse.json({ error: 'member_unavailable' }, { status: 503 });
  }
  if (!target) return refuse('no_such_member');

  const targetPlayer = target as unknown as { id: string; full_name: string | null };

  // Who holds this snowflake now. FOR THE MESSAGE ONLY: the UNIQUE index on
  // player_discord_links.discord_user_id is the actual guarantee, and the write
  // below still handles the refusal, because two officers can pass this check at
  // the same moment and only one of them can win the upsert.
  const { data: owner, error: ownerError } = await supabase
    .from('player_discord_links')
    .select('player_id')
    .eq('discord_user_id', targetDiscordUserId)
    .maybeSingle();

  if (ownerError) {
    console.error('[discord] force-link conflict read failed:', ownerError.message);
    return NextResponse.json({ error: 'link_unavailable' }, { status: 503 });
  }

  const ownerPlayerId = (owner as unknown as { player_id?: string } | null)?.player_id ?? null;
  if (ownerPlayerId && ownerPlayerId !== targetPlayer.id) {
    return refuse('already_linked_elsewhere');
  }

  // What this member is linked to TODAY, read before anything is written,
  // because after the write it is unrecoverable: this is the account the upsert
  // displaces.
  const { data: current, error: currentError } = await supabase
    .from('player_discord_links')
    .select('discord_user_id')
    .eq('player_id', targetPlayer.id)
    .maybeSingle();

  if (currentError) {
    // Not degraded to "no current link" either, and this one has teeth: a null
    // here would lose the displaced account from both the audit reason and the
    // immediate strip, leaving it holding club roles until the next sweep with
    // nothing in the log naming it.
    console.error('[discord] force-link current read failed:', currentError.message);
    return NextResponse.json({ error: 'link_unavailable' }, { status: 503 });
  }

  const currentDiscordUserId =
    (current as unknown as { discord_user_id?: string } | null)?.discord_user_id ?? null;

  // Re-linking to the same id displaces nothing, which is the NULLIF the SQL
  // path returns for this case (consume_discord_link_token, 00165).
  const displacedDiscordUserId =
    currentDiscordUserId && currentDiscordUserId !== targetDiscordUserId
      ? currentDiscordUserId
      : null;
  const alreadyThatAccount = currentDiscordUserId === targetDiscordUserId;

  // ONE UPSERT, CONFLICT TARGET `player_id`. THIS SHAPE IS LOAD-BEARING AND IS
  // NOT INTERCHANGEABLE WITH THE ALTERNATIVES.
  //
  // queue_discord_role_revocation() (supabase/migrations/00165_discord_links.sql)
  // is an AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW trigger on this
  // table, and it is what takes the club roles off the account being displaced.
  // It tombstones OLD.discord_user_id into discord_role_revocations on DELETE
  // always, and on UPDATE ONLY when
  // `OLD.discord_user_id IS DISTINCT FROM NEW.discord_user_id`. So:
  //
  //   - A plain INSERT violates the player_id primary key on a re-link, so the
  //     re-link simply fails.
  //   - `ignoreDuplicates: true` turns that failure into a silent no-op: the
  //     route reports success, the link never moves, and the displaced account
  //     keeps its club roles for good.
  //   - A DELETE followed by an INSERT does tombstone the displaced account
  //     correctly: the trigger's second half only clears a tombstone naming
  //     NEW.discord_user_id, and that is the ARRIVING account, not the displaced
  //     one. It is rejected for a different reason. It is two PostgREST round
  //     trips with no transaction around them, so a failure between them leaves
  //     the member with no link row at all while the old account has already
  //     been queued for a strip.
  //
  // NO TEST IN THIS REPO CAN CATCH ANY OF THAT, because every test here mocks
  // PostgREST and none of them run the trigger. The UPDATE path is the only one
  // that both satisfies the IS DISTINCT FROM condition and gets there in a
  // single statement, so the write has to be one upsert that conflicts on
  // player_id and updates in place.
  //
  // last_synced_at goes back to null so the bot re-syncs this member's roles
  // from scratch rather than trusting a sync that happened to the old account.
  const { error: writeError } = await supabase.from('player_discord_links').upsert(
    {
      player_id: targetPlayer.id,
      discord_user_id: targetDiscordUserId,
      linked_at: new Date().toISOString(),
      last_synced_at: null,
    },
    { onConflict: 'player_id' }
  );

  if (writeError) {
    // The UNIQUE on discord_user_id, which is the real guarantee behind the
    // pre-check above and the one that holds when two officers race.
    if (
      writeError.code === '23505' ||
      writeError.message.includes('player_discord_links_discord_user_id_key')
    ) {
      return refuse('already_linked_elsewhere');
    }
    console.error('[discord] force-link write failed:', writeError.message);
    Sentry.captureException(new Error(`Discord force link failed: ${writeError.message}`), {
      extra: { playerId: targetPlayer.id, actorId: player.id },
    });
    return NextResponse.json({ error: 'force_link_failed' }, { status: 503 });
  }

  // AUDITED LIKE THE CONSOLE'S, because it is the same act by the same kind of
  // person, and the audit log is meant to be the record of a row's history
  // rather than the record of the admin app's activity.
  //
  // WRITTEN INLINE, and not through logMemberAudit(). That helper
  // (apps/player/src/lib/member-audit.ts:55-74) pins target_type and target_id
  // to the ACTOR, which is exactly what this act cannot use: the actor is the
  // officer and the target is the member being linked, and they are different
  // people. Filing this through it would record an officer editing themselves.
  //
  // FAILURE IS REPORTED, NEVER THROWN: the link is already written, and losing
  // the row that describes it must not also lose the officer's reply.
  //
  // AND THE CONSEQUENCE OF THAT IS WORSE HERE THAN IN THE CONSOLE, so it is
  // written down: THE PLAYER APP HAS NO DEGRADED AUDIT RETRY. The console's
  // logAdminAudit retries a refused insert without old_value/new_value
  // (apps/admin/src/lib/audit.ts:109-133), so it still lands a row. There is no
  // equivalent on this side, so a refused insert here loses the WHOLE row and
  // Sentry is the only record left.
  //
  // THE DISPLACED ID GOES IN THE REASON, not only in old_value, and the
  // sentence is the console's word for word. Two things erase it otherwise: the
  // degraded retry described above drops old_value/new_value, and the tombstone
  // that currently names it is deleted by the bot as soon as the sweep clears
  // it. The reason is the one field that survives both.
  const { error: auditError } = await supabase.from('audit_logs').insert({
    actor_id: player.id,
    action_type: 'discord_link_forced',
    target_type: 'player',
    target_id: targetPlayer.id,
    old_value: { discord_user_id: currentDiscordUserId },
    new_value: { discord_user_id: targetDiscordUserId },
    reason: displacedDiscordUserId
      ? `${reason} (displaced Discord account ${displacedDiscordUserId}, which loses its club roles on the next sweep)`
      : reason,
  });

  if (auditError) {
    Sentry.captureException(new Error(`Discord force link audit failed: ${auditError.message}`), {
      extra: { playerId: targetPlayer.id, actorId: player.id, source: 'discord' },
    });
  }

  return NextResponse.json({
    ok: true,
    displacedDiscordUserId,
    memberName: targetPlayer.full_name,
    alreadyThatAccount,
  });
}
