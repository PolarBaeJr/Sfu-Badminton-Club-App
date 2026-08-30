import { createServiceRoleClient } from './supabase-server';
import { statusForViewer, mayViewRow } from './public-profile';
import type { PlayerStatus } from '@badminton/shared';

/**
 * The profile card's data, and the one place that decides what a card may say.
 *
 * READ BY TWO ROUTES: /api/discord/profile (behind the service secret, answers
 * the bot) and /api/discord/card/[token] (anonymous, answers Discord's CDN and
 * draws the PNG). They must agree, so neither of them holds the rules.
 *
 * THE CARD IS ALWAYS THE STRANGER'S VIEW, including on /profile with no
 * arguments, where the caller is looking at themselves. Two reasons, and both
 * are about the artifact rather than the member:
 *
 *   1. It is posted into a shared channel. Rendering the member's own
 *      moderation status because they are the one who typed the command would
 *      publish it to everyone reading, which is the disclosure the web
 *      profile's status suppression exists to prevent.
 *   2. Discord proxies the PNG through media.discordapp.net and keeps what it
 *      fetched. A card is not a page that can be re-rendered when a member
 *      later changes their mind — whatever it says is said permanently.
 *
 * So `hide_from_leaderboard` is honoured even against the member's own card,
 * unlike /leaderboard/[playerId] where the carve-out is correct because nobody
 * else is looking.
 */

export interface LadderLine {
  elo: number;
  provisional: boolean;
  wins: number;
  losses: number;
  streak: number;
  /** Position on this ladder among ranked players. */
  rank: number;
}

export interface CardBackground {
  /**
   * WHICH background to paint. Today there is exactly one and no column
   * behind it — see resolveBackground. The field exists so that adding a
   * second is a change to one function and one switch in the renderer, not a
   * change to the payload shape, the route, the bot and the card at once.
   */
  kind: string;
}

export interface CardAward {
  /**
   * Short label, e.g. "Fall 2026 Champion".
   *
   * TEXT ONLY, and there is deliberately no glyph field beside it. The card is
   * drawn in Barlow -- latin, latin-ext and vietnamese -- and a star, a medal
   * or an emoji is in none of those subsets, so satori draws a tofu box with
   * no warning anywhere. A symbol here means shipping a face that has it,
   * which is a decision to make when awards actually arrive rather than a hook
   * that quietly renders wrong the first time it is used.
   */
  label: string;
}

export interface DiscordProfile {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  /** Already collapsed to what a stranger may see; null means draw no pill. */
  status: PlayerStatus | null;
  /** False when the member is not on the public ladder — then both lines are null. */
  ranked: boolean;
  doubles: LadderLine | null;
  singles: LadderLine | null;
  tournamentPoints: number | null;
  background: CardBackground;
  /**
   * NOT BUILT YET, and deliberately shipped as a field rather than left out.
   * The renderer already lays this out and already handles the empty case,
   * which is the only case that exists today — so awards become a change to
   * this one function, with no layout work and no payload change.
   */
  awards: CardAward[];
}

/**
 * The card's background, for a member who has not chosen one because there is
 * nothing to choose from yet.
 *
 * WHEN A CHOICE ARRIVES this reads the column and returns its value; the
 * renderer's switch grows a case. Nothing else moves. The column does not
 * exist yet on purpose — an unrun migration sitting in the numbered sequence
 * is worse than a function that returns a constant.
 */
function resolveBackground(_row: { id: string }): CardBackground {
  return { kind: 'default' };
}

/** See DiscordProfile.awards. Empty until awards exist. */
function resolveAwards(_row: { id: string }): CardAward[] {
  return [];
}

type LeaderboardRow = {
  id: string;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  status: string;
  singles_elo: number;
  doubles_elo: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  singles_provisional: boolean;
  doubles_provisional: boolean;
  current_singles_streak: number;
  current_doubles_streak: number;
  tournament_points: number;
};

/**
 * The public ladder, exactly as the website and /leaderboard see it.
 *
 * get_leaderboard() ends with `active_flag AND NOT hide_from_leaderboard AND
 * status NOT IN ('pending_approval','suspended')`, so absence from this list IS
 * the visibility decision — already made, in the database, by the same function
 * every other surface asks. Re-deriving it here would put the club's rules in a
 * second place where they would drift.
 */
async function loadLadder(): Promise<LeaderboardRow[]> {
  const { data, error } = await createServiceRoleClient().rpc('get_leaderboard');
  if (error) {
    console.error('[discord] card ladder read failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as LeaderboardRow[];
}

function rankBy(rows: LeaderboardRow[], column: 'singles_elo' | 'doubles_elo') {
  const order = [...rows].sort((a, b) => b[column] - a[column]);
  const at = new Map<string, number>();
  order.forEach((r, i) => at.set(r.id, i + 1));
  return at;
}

export type ProfileTarget =
  | { by: 'discordUserId'; value: string }
  | { by: 'handle'; value: string }
  | { by: 'playerId'; value: string };

export type ProfileMiss =
  | 'not_linked'      // the caller has no link row
  | 'target_unlinked' // the mentioned Discord account has no link row
  | 'no_such_handle'
  | 'not_found';

/**
 * HANDLE LOOKUP READS THE LADDER, NOT players.handle.
 *
 * That is the whole privacy answer for the handle option. A member who is off
 * the public ladder — hidden by their own setting, suspended, or not yet
 * approved — has no ladder row, so no handle anyone can type finds them, and
 * the bot cannot be used to mint a permanently-cached public image of somebody
 * who asked not to be listed. Reading players.handle directly would find them
 * all and would be a strictly wider surface than the website it mirrors.
 */
export async function resolveProfile(
  target: ProfileTarget
): Promise<{ profile: DiscordProfile } | { miss: ProfileMiss }> {
  const supabase = createServiceRoleClient();

  let playerId: string | null = null;

  if (target.by === 'playerId') {
    playerId = target.value;
  } else if (target.by === 'discordUserId') {
    const { data } = await supabase
      .from('player_discord_links')
      .select('player_id')
      .eq('discord_user_id', target.value)
      .maybeSingle();
    playerId = (data as { player_id?: string } | null)?.player_id ?? null;
    if (!playerId) return { miss: 'not_linked' };
  }

  const ladder = await loadLadder();

  if (target.by === 'handle') {
    const wanted = target.value.trim().replace(/^@/, '').toLowerCase();
    const hit = ladder.find((r) => (r.handle ?? '').toLowerCase() === wanted);
    if (!hit) return { miss: 'no_such_handle' };
    playerId = hit.id;
  }

  if (!playerId) return { miss: 'not_found' };

  // bio is not on the ladder function, and neither is the row of somebody the
  // ladder excludes — a member looking up their own card while hidden still
  // gets a card, just without numbers on it.
  const { data: row } = await supabase
    .from('players')
    .select('id, full_name, handle, avatar_url, bio, status')
    .eq('id', playerId)
    .maybeSingle();

  const player = row as unknown as {
    id: string;
    full_name: string;
    handle: string | null;
    avatar_url: string | null;
    bio: string | null;
    status: string;
  } | null;

  if (!player) return { miss: 'not_found' };

  // The service-role key skips RLS as well as the column grants, so
  // players_select's row rule is re-applied by hand — the same reasoning, and
  // the same helper, as getPublicProfile. A stranger is neither self nor admin.
  if (!mayViewRow(player.status, false, false)) return { miss: 'not_found' };

  const line = ladder.find((r) => r.id === player.id) ?? null;
  const dRank = rankBy(ladder, 'doubles_elo');
  const sRank = rankBy(ladder, 'singles_elo');

  return {
    profile: {
      id: player.id,
      name: player.full_name,
      // The ladder's handle when it has one, so the card and /leaderboard
      // cannot disagree; the row's own otherwise.
      handle: line?.handle ?? player.handle ?? null,
      avatarUrl: line?.avatar_url ?? player.avatar_url ?? null,
      bio: player.bio ?? null,
      status: statusForViewer(player.status, false),
      ranked: !!line,
      doubles: line
        ? {
            elo: line.doubles_elo,
            provisional: line.doubles_provisional,
            wins: line.doubles_wins,
            losses: line.doubles_losses,
            streak: line.current_doubles_streak,
            rank: dRank.get(line.id) ?? 0,
          }
        : null,
      singles: line
        ? {
            elo: line.singles_elo,
            provisional: line.singles_provisional,
            wins: line.singles_wins,
            losses: line.singles_losses,
            streak: line.current_singles_streak,
            rank: sRank.get(line.id) ?? 0,
          }
        : null,
      tournamentPoints: line ? line.tournament_points : null,
      background: resolveBackground(player),
      awards: resolveAwards(player),
    },
  };
}
