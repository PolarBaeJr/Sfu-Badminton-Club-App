import { createServiceRoleClient } from './supabase-server';
import { statusForViewer, mayViewRow } from './public-profile';
import type { PlayerStatus } from '@badminton/shared';
import { HANDLE_MIN_LENGTH, HANDLE_MAX_LENGTH } from '@badminton/shared';
import { PRESENT_STATUSES } from './schedule';

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
  /** Position on this ladder among ranked players -- the OPEN ladder, everyone. */
  rank: number;
  /**
   * Position among competitive members only, or null for a member who is not
   * one.
   *
   * THE CLUB RANKS THE SAME TWO ELOS TWICE. /leaderboard has four ladder tabs
   * off two numbers -- Open Singles, Open Doubles, Comp Singles, Comp Doubles
   * -- and the only difference between an open tab and its comp twin is the
   * population: comp keeps `status === 'competitive'` and open keeps everyone
   * (leaderboard-client.tsx:259). The elo is identical. So a competitive member
   * holds two ranks per discipline, and the card used to show only the open one
   * without saying that is what it was.
   */
  compRank: number | null;
}

/**
 * One row of the card's recent form.
 *
 * THE SCORE READS SUBJECT-FIRST. `matches.score_summary` is written as
 * `sideA-sideB` per game (admin/lib/actions/matches.ts:300), which is not a
 * point of view -- it is whichever side the submitting admin happened to enter
 * first. A card that printed it raw would show the member losing 15-21 a match
 * they won, so each pair is flipped when the member played on side 'b'.
 */
export interface CardMatch {
  won: boolean;
  /** 'singles' | 'doubles'. Drawn as a one-letter marker, not a word. */
  type: string;
  /** Already oriented subject-first, e.g. "21-15, 19-21, 21-18". */
  score: string | null;
  /**
   * The other side, and ONLY the members of it who are on the public ladder.
   *
   * THIS IS THE CARD'S FIRST MENTION OF ANYONE BUT ITS SUBJECT, and it is the
   * reason this field is a list of names rather than a list of players. Every
   * other figure on the card is about the member who ran /profile or was named
   * by them, and resolveProfile guarantees that member is on the ladder. An
   * opponent is not: they may be hidden by their own setting, suspended, or
   * waiting for approval, and none of them asked to appear in a public PNG
   * that Discord's CDN keeps for good. So an opponent the ladder does not list
   * contributes no name and the row renders as score-and-result.
   *
   * /leaderboard/[playerId] deliberately does the opposite -- see its own
   * comment, "WHAT IT HIDES IS THE RATING, NOT THE PERSON" -- and that is
   * right for a page behind a session that re-renders on every visit. It is
   * the same asymmetry, and the same reason, as the subject's own status.
   */
  opponents: string[];
}

/** The opponent the member has played most, with the member's own record. */
export interface CardRival {
  name: string;
  wins: number;
  losses: number;
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
  /**
   * Up to three most recent CONFIRMED matches, newest first.
   *
   * Empty for a member with no confirmed matches -- and also for every member
   * who is off the public ladder, who is never asked for. See loadForm.
   */
  recent: CardMatch[];
  /** Null when nobody qualifies; see loadForm for what qualifies. */
  rival: CardRival | null;
  /** Sessions the member actually attended. Null when not fetched. */
  nights: number | null;
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

/**
 * The competitive population, for the comp half of each ladder.
 *
 * The status string is matched here rather than in the database because
 * get_leaderboard() has already made the VISIBILITY decision and this is a
 * different question -- which of the visible members share a peer group. It
 * mirrors /leaderboard's own filter exactly; if that ever moves off `status`,
 * both places have to move together.
 */
function competitiveOnly(rows: LeaderboardRow[]): LeaderboardRow[] {
  return rows.filter((r) => r.status === 'competitive');
}

/**
 * The score, turned round so it reads from the member's side.
 *
 * `matches.score_summary` is `sideA-sideB` per game, joined with ", " (see
 * admin/lib/actions/matches.ts:300). Side A is not a point of view -- it is
 * whichever side the submitting admin entered first -- so printing it raw
 * shows half the club losing 15-21 matches they won.
 */
function orientScore(summary: string | null, side: string | null): string | null {
  if (!summary) return null;
  if (side !== 'b') return summary;
  return summary
    .split(',')
    .map((game) => {
      const pair = game.trim().match(/^(\d+)-(\d+)$/);
      return pair ? `${pair[2]}-${pair[1]}` : game.trim();
    })
    .join(', ');
}

/** Least a pair must have played before "rival" means anything. */
const RIVAL_MIN_MATCHES = 2;

/** How many recent matches the card has room to draw. */
const RECENT_LIMIT = 3;

interface CardForm {
  recent: CardMatch[];
  rival: CardRival | null;
  /** Null means NOT FETCHED, which is not the same claim as zero nights. */
  nights: number | null;
}

const NO_FORM: CardForm = { recent: [], rival: null, nights: null };

/**
 * Recent form, the top rival and nights played.
 *
 * ONLY EVER CALLED FOR A MEMBER WHO IS ON THE LADDER, and the caller enforces
 * that rather than this function re-deriving it. Somebody the ladder excludes
 * gets the card's "Unranked" block and none of this: their match history on a
 * permanently-cached public image is the same disclosure that keeping their
 * rating off the ladder exists to prevent, and it would be a strange privacy
 * setting that hid the number but published the games behind it.
 *
 * THE LADDER IS ALSO THE NAMING RULE. `ladder` is the list the caller already
 * fetched, so deciding whether an opponent may be named costs nothing and
 * cannot disagree with the decision made about the subject -- see
 * CardMatch.opponents.
 *
 * EVERY READ HERE FAILS TO EMPTY, WHICH IS WHY THE CARD IS VERIFIED AGAINST A
 * REAL MEMBER rather than a fixture. PostgREST answers a read it cannot serve
 * -- a mistyped embed, a missing grant -- with an empty list and no error, and
 * "no matches yet" is exactly what a broken query looks like. my-stats' best-
 * partners query shipped that way and returned nothing for months.
 */
async function loadForm(
  supabase: ReturnType<typeof createServiceRoleClient>,
  playerId: string,
  ladder: LeaderboardRow[]
): Promise<CardForm> {
  const named = new Map(ladder.map((r) => [r.id, r.name]));

  const [matchesRes, h2hRes, nightsRes] = await Promise.all([
    // Based on `matches`, not on `match_participants`, so ORDER BY played_at is
    // a real ordering -- PostgREST cannot order parent rows by a column of a
    // to-one embed, and the participant-first form of this query takes three
    // arbitrary rows and calls them recent. Same reasoning as my-stats.
    //
    // CASUAL AND UNRATED MATCHES COUNT. The section says what the member last
    // played, and a Friday club game is something they played; nothing in the
    // row is an Elo figure, so there is no rated number for an unrated match to
    // sit beside and misrepresent.
    supabase
      .from('matches')
      .select(
        'id, played_at, match_type, score_summary, winner_side, participants:match_participants!inner(player_id)'
      )
      .eq('participants.player_id', playerId)
      // A disputed or voided match rendered as a win on an image nobody can
      // recall is the one kind of wrong this section must not produce.
      .eq('result_status', 'confirmed')
      .not('played_at', 'is', null)
      .order('played_at', { ascending: false })
      .limit(RECENT_LIMIT),
    // The CHECK on this table is `player_a_id < player_b_id`, so which column
    // holds the member is not knowable in advance and neither is which win
    // count is theirs. Rows are per match_type; a rival is a person, so the
    // two are added together below.
    supabase
      .from('head_to_head_stats')
      .select('player_a_id, player_b_id, player_a_wins, player_b_wins, total_matches')
      .or(`player_a_id.eq.${playerId},player_b_id.eq.${playerId}`)
      .order('total_matches', { ascending: false })
      .limit(20),
    // Nights the member was actually there -- not nights on their record.
    // `no_show` and `excused` are rows too. See PRESENT_STATUSES.
    supabase
      .from('session_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('player_id', playerId)
      .in('status', [...PRESENT_STATUSES]),
  ]);

  type MatchRow = {
    id: string;
    played_at: string | null;
    match_type: string | null;
    score_summary: string | null;
    winner_side: string | null;
  };
  const matches = (matchesRes.data ?? []) as unknown as MatchRow[];

  let recent: CardMatch[] = [];
  if (matches.length > 0) {
    // A SECOND READ, because the !inner filter above narrows the embed to this
    // member's own row -- that is what makes it a filter. The other side has to
    // be asked for separately.
    const { data: sidesData } = await supabase
      .from('match_participants')
      .select('match_id, player_id, team_side, win_flag')
      .in(
        'match_id',
        matches.map((m) => m.id)
      );
    const sides = (sidesData ?? []) as unknown as {
      match_id: string;
      player_id: string;
      team_side: string | null;
      win_flag: boolean | null;
    }[];

    recent = matches.flatMap((m) => {
      const rows = sides.filter((r) => r.match_id === m.id);
      const mine = rows.find((r) => r.player_id === playerId) ?? null;
      const side = mine?.team_side ?? null;
      // NO ROW, NO CLAIM. Without the member's own participant row there is no
      // side to orient the score by and no result to report, and the defaults
      // are not neutral: `won` would be false and the score would print in the
      // admin's entry order, so a read that came back short would render three
      // losses at inverted scores onto an image Discord keeps. This read cannot
      // disagree with the one above except transiently -- same client, same
      // key -- and a row missing from the card is the honest way to lose that
      // race.
      //
      // `side === null` is the type narrowing and not a second case:
      // match_participants.team_side is NOT NULL (00001), and staging reads
      // zero rows without one.
      if (!mine || side === null) return [];
      return [{
        // win_flag is nullable; winner_side is the same answer from the match
        // rather than from the participant, and one of the two is always set on
        // a confirmed result.
        won: mine.win_flag ?? m.winner_side === side,
        type: m.match_type ?? 'singles',
        score: orientScore(m.score_summary, side),
        opponents: rows
          .filter((r) => r.player_id !== playerId && r.team_side !== side)
          .map((r) => named.get(r.player_id))
          .filter((n): n is string => !!n),
      }];
    });
  }

  type H2HRow = {
    player_a_id: string;
    player_b_id: string;
    player_a_wins: number;
    player_b_wins: number;
    total_matches: number;
  };
  const tally = new Map<string, { total: number; wins: number; losses: number }>();
  for (const row of (h2hRes.data ?? []) as unknown as H2HRow[]) {
    const subjectIsA = row.player_a_id === playerId;
    const other = subjectIsA ? row.player_b_id : row.player_a_id;
    // Only somebody the ladder lists may be named, exactly as for opponents.
    if (!named.has(other)) continue;
    const acc = tally.get(other) ?? { total: 0, wins: 0, losses: 0 };
    acc.total += row.total_matches;
    acc.wins += subjectIsA ? row.player_a_wins : row.player_b_wins;
    acc.losses += subjectIsA ? row.player_b_wins : row.player_a_wins;
    tally.set(other, acc);
  }
  let rival: CardRival | null = null;
  let rivalTotal = 0;
  for (const [id, acc] of tally) {
    // One meeting is not a rivalry, and "vs Sam 1-0" on a card reads as a
    // claim about a matchup rather than the coincidence it is.
    if (acc.total < RIVAL_MIN_MATCHES || acc.total <= rivalTotal) continue;
    rivalTotal = acc.total;
    rival = { name: named.get(id)!, wins: acc.wins, losses: acc.losses };
  }

  return { recent, rival, nights: nightsRes.count ?? 0 };
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
export interface ResolveOptions {
  /**
   * Fetch recent form, the top rival and nights played -- four extra reads.
   *
   * OFF BY DEFAULT because only one of this resolver's two callers draws them.
   * /api/discord/card renders the PNG and wants them; /api/discord/profile
   * answers the bot, which now sends the card and NOTHING ELSE -- `bio` and the
   * provisional footnote used to be message text and are drawn into the PNG
   * instead, so all this payload is still read for is the card URL and the
   * fields the reply cannot render. That path is also the one on Discord's
   * three-second interaction deadline -- handleProfile replies rather than
   * deferring -- so making it pay for four reads it never renders is how
   * /profile starts timing out, and it would do so first on staging, where
   * SUPABASE_INTERNAL_URL is unset and every call hairpins.
   *
   * THE RULES DO NOT MOVE WITH THE FLAG. What may be said about a member, and
   * about anyone named beside them, is still decided only in this file; this
   * chooses how much is asked for, not what is allowed.
   */
  withForm?: boolean;
}

export async function resolveProfile(
  target: ProfileTarget,
  options: ResolveOptions = {}
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

  // A HANDLE THAT CANNOT EXIST IS REFUSED BEFORE THE LADDER READ. The length
  // bound is players_handle_shape_check's own (00092: `^[a-z][a-z0-9_]{2,19}$`),
  // borrowed from shared rather than restated here, so nothing outside those
  // bounds has a row to find. This matters because the option is free text a
  // member types in Discord and the card route it feeds is anonymous: without
  // it, a mistyped -- or 2000-character -- handle costs a full club read before
  // missing. The miss is the SAME 'no_such_handle' either way; the caller
  // cannot tell a refused shape from an absent member.
  let wanted: string | null = null;
  if (target.by === 'handle') {
    wanted = target.value.trim().replace(/^@/, '').toLowerCase();
    if (wanted.length < HANDLE_MIN_LENGTH || wanted.length > HANDLE_MAX_LENGTH) {
      return { miss: 'no_such_handle' };
    }
  }

  const ladder = await loadLadder();

  if (wanted !== null) {
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
  // Ranked over the competitive subset, so a competitive member's position here
  // is among their own peer group. A member who is not competitive is absent
  // from these maps and gets null, which is what the card draws nothing for.
  const comp = competitiveOnly(ladder);
  const dCompRank = rankBy(comp, 'doubles_elo');
  const sCompRank = rankBy(comp, 'singles_elo');

  // `line` is the gate, not `options.withForm` alone: a member off the public
  // ladder never has form fetched for them, whoever asked and for whatever
  // reason. See loadForm.
  const form = options.withForm && line ? await loadForm(supabase, player.id, ladder) : NO_FORM;

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
            compRank: dCompRank.get(line.id) ?? null,
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
            compRank: sCompRank.get(line.id) ?? null,
          }
        : null,
      tournamentPoints: line ? line.tournament_points : null,
      background: resolveBackground(player),
      awards: resolveAwards(player),
      recent: form.recent,
      rival: form.rival,
      nights: form.nights,
    },
  };
}
