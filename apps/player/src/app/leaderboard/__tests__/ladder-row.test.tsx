import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LadderRow, type LeaderboardEntry } from '../leaderboard-client';

/**
 * The ladder row's subline, checked through a real render.
 *
 * renderToStaticMarkup and not a DOM: this app's vitest runs `environment:
 * 'node'` and carries neither jsdom nor testing-library, the same posture
 * announcement-markdown.test.tsx and the console's roster-window test explain.
 * A server render is enough here because the subline is computed during render
 * and depends on no interaction at all.
 *
 * WHY THIS EXISTS: "Provisional" is an ELO flag. It says how settled a RATING
 * is. On the tournament-points tab it was being printed beside a POINTS total,
 * which it describes nothing about, because the subline was built with no isTpts
 * guard while the record and win-share beside it both had one. isTpts also
 * forces isDoubles false, so the flag shown was specifically the SINGLES elo
 * flag, next to points that can be earned in doubles events.
 *
 * The first test is the control: it fails if a fix "works" by never rendering
 * the flag at all, which would be a regression dressed up as the fix.
 */
const entry: LeaderboardEntry = {
  id: 'p1',
  full_name: 'Kiera Watanabe',
  handle: 'kiera',
  avatar_url: null,
  status: 'competitive',
  _tournamentPoints: 200,
  ratings: {
    singles_elo: 400,
    doubles_elo: 400,
    singles_wins: 0,
    singles_losses: 0,
    doubles_wins: 0,
    doubles_losses: 0,
    // Both true, so a row that reads the wrong one still looks "right" and only
    // the tab it is shown ON can distinguish the fix from the bug.
    singles_provisional: true,
    doubles_provisional: true,
    current_singles_streak: 0,
    current_doubles_streak: 0,
  },
};

const draw = (isTpts: boolean, showRecord = !isTpts, player: LeaderboardEntry = entry, rank = 1) =>
  renderToStaticMarkup(
    <LadderRow
      player={player}
      rank={rank}
      isMe={false}
      isDoubles={false}
      isTpts={isTpts}
      showRecord={showRecord}
      canChallenge={false}
      onChallenge={() => {}}
    />,
  );

describe('the ladder row subline', () => {
  it('still says Provisional on a rating tab, where the flag belongs', () => {
    const html = draw(false);
    expect(html).toContain('Provisional');
    expect(html).toContain('@kiera');
  });

  it('does not call a tournament points total Provisional', () => {
    const html = draw(true);
    expect(html).not.toContain('Provisional');
    // The rest of the subline must survive: the guard removes the flag, not the
    // handle beside it.
    expect(html).toContain('@kiera');
  });
});

/**
 * The same row on a finished season's ladder.
 *
 * `showRecord` is the one prop separating these two renders, and what it governs
 * is a claim rather than a layout. A record, a win rate and a streak are ALL-TIME
 * columns on `ratings`: the rollover rebases the Elo beside them and resets no
 * other counter, and nothing in the database stores a per-season version of any
 * of them. So printing them next to an archived closing Elo states one figure
 * about the term and three about a career, in one line, on a screen whose whole
 * subject is the term.
 *
 * A member with a real record, so the wrong behaviour has something to print.
 * 1847 is the Elo the source comment uses for exactly this row, and 18 wins to 6
 * is the 75% beside it.
 */
const played: LeaderboardEntry = {
  ...entry,
  ratings: {
    singles_elo: 1847,
    doubles_elo: 1600,
    singles_wins: 18,
    singles_losses: 6,
    doubles_wins: 4,
    doubles_losses: 4,
    singles_provisional: true,
    doubles_provisional: false,
    current_singles_streak: 3,
    current_doubles_streak: 0,
  },
};

/** An archived entry: the two Elos and nothing else, as lib/past-leaderboard builds them. */
const archived: LeaderboardEntry = {
  ...entry,
  _tournamentPoints: undefined,
  ratings: { singles_elo: 1847, doubles_elo: 1600 },
};

describe('a finished season row', () => {
  it('must not display an all-time win rate as if it were seasonal', () => {
    const html = draw(false, false, played, 7);

    expect(html).not.toContain('18–6');
    expect(html).not.toContain('75%');
    expect(html).not.toContain('W3');
    expect(html).not.toContain('Provisional');

    // AND STILL DRAWS THE ROW. A "fix" that rendered nothing would pass every
    // assertion above, so the two figures a past-season ladder exists to show are
    // pinned here: the archived Elo, and the place it earned.
    expect(html).toContain('1847');
    expect(html).toContain('class="lr-rank">7<');
    expect(html).toContain('Kiera Watanabe');
  });

  // THE CONTROL. Without it, deleting the record block outright would pass the
  // test above and take the live ladder's metrics with it.
  it('still shows record, win rate and streak on the live ladder', () => {
    const html = draw(false, true, played, 7);

    expect(html).toContain('18–6');
    expect(html).toContain('75%');
    expect(html).toContain('W3');
    expect(html).toContain('1847');
  });

  // The exact string a naive implementation ships. An archived entry has no wins
  // column at all, so `recordOf` answers 0 and 0, and a row that renders the
  // block anyway prints "0–0 · 0%", which reads as a member who turned up to the
  // whole term and never won rather than as a figure nothing recorded.
  it('does not print a zero record for an archived entry', () => {
    const html = draw(false, false, archived, 7);

    expect(html).not.toContain('0–0');
    expect(html).not.toContain('0%');
    expect(html).toContain('1847');
  });
});
