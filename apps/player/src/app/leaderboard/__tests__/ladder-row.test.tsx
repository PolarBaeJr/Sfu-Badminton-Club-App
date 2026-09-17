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

const draw = (isTpts: boolean) =>
  renderToStaticMarkup(
    <LadderRow
      player={entry}
      rank={1}
      isMe={false}
      isDoubles={false}
      isTpts={isTpts}
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
