import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChallengeSections,
  SEARCH_THRESHOLD,
  type ChallengeItem,
} from '../../app/challenges/challenge-sections';

/**
 * The /challenges list shell, through a real render. renderToStaticMarkup and
 * not a DOM, the same posture as tour-render.test.tsx: what this pins is which
 * pieces appear for a given list, not how they respond to typing.
 */

const item = (id: string, name: string): ChallengeItem => ({
  id,
  players: [name],
  card: <a className="chal-row" href={`/challenges/${id}`}>{`vs ${name}`}</a>,
});
const many = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, `Player ${prefix}${i}`));

const EMPTY = <div data-testid="empty">No open challenges</div>;

const draw = (live: ChallengeItem[], archived: ChallengeItem[]) =>
  renderToStaticMarkup(
    <ChallengeSections
      sections={[
        { title: 'Awaiting your answer', items: live.slice(0, 1), accent: true },
        { title: 'Active', items: live.slice(1) },
      ]}
      archived={archived}
      empty={EMPTY}
    />,
  );

describe('ChallengeSections', () => {
  it('draws no search box until the list is long enough to need one', () => {
    expect(draw(many('l', 3), many('a', SEARCH_THRESHOLD - 3))).not.toContain('role="searchbox"');
    expect(draw(many('l', 3), many('a', SEARCH_THRESHOLD - 2))).toContain('role="searchbox"');
  });

  it('keeps Archived collapsed behind a disclosure that shows its count', () => {
    const html = draw(many('l', 2), many('a', 3));
    const details = html.match(/<details[^>]*>/)?.[0];
    expect(details).toBeDefined();
    expect(details).not.toMatch(/\sopen/);
    expect(html).toMatch(/<summary[^>]*>.*Archived.*<span class="tag">3<\/span>.*<\/summary>/);
  });

  it('shows the empty state only when nothing is live, and above the archive', () => {
    expect(draw(many('l', 1), many('a', 2))).not.toContain('data-testid="empty"');

    const html = draw([], many('a', 2));
    expect(html).toContain('data-testid="empty"');
    expect(html.indexOf('data-testid="empty"')).toBeLessThan(html.indexOf('<details'));
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('draws no disclosure when there is no history', () => {
    const html = draw([], []);
    expect(html).toContain('data-testid="empty"');
    expect(html).not.toContain('<details');
  });

  it('marks the section that is waiting on the reader', () => {
    const html = draw(many('l', 2), []);
    expect(html).toMatch(/<section class="chal-section" data-accent="true">.*Awaiting your answer/);
    expect(html).toContain('<span class="tag tag-red">1</span>');
  });
});

describe('the /challenges page source', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'app', 'challenges', 'page.tsx'), 'utf8');

  it('anchors the header New challenge link for the tour, and only that one', () => {
    expect(src).toMatch(/<Link href="\/challenges\/new"[^>]*data-tour="new-challenge"/);
    expect(src.match(/data-tour="new-challenge"/g)).toHaveLength(1);
  });

  it('has no em dash in anything it renders', () => {
    // Comments may still carry them; JSX text and string literals may not.
    const code = src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('\u2014');
  });
});
