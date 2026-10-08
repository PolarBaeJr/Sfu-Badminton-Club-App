import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RosterTable, type RosterRow } from '../roster-table';

/**
 * The roster window, checked through a real render rather than by re-deriving
 * the arithmetic in the test.
 *
 * renderToStaticMarkup and not a DOM: this app's vitest runs `environment:
 * 'node'` and carries neither jsdom nor testing-library, and pulling both in to
 * assert "25 rows, not 60" would be a bigger change than the one under test.
 * The trade is explicit — a server render exercises the FIRST window (initial
 * useState, the slice, the count line, the button's presence) and cannot
 * exercise IntersectionObserver, which never fires outside a browser. The first
 * window is where the regression risk actually is: a roster that renders all 500
 * rows anyway, or one that renders 25 and then tells the reader they are looking
 * at all of them.
 */
const row = (id: string, name: string): RosterRow => ({
  id,
  name,
  handle: null,
  meta: `${id}@example.com`,
  row: <tr data-testid={id}><td>{name}</td></tr>,
  card: <div data-testid={`card-${id}`}>{name}</div>,
});

const make = (n: number) =>
  Array.from({ length: n }, (_, i) => row(`p${i}`, `Player ${String(i).padStart(3, '0')}`));

const render = (rows: RosterRow[], total = rows.length) =>
  renderToStaticMarkup(
    <RosterTable head={<tr><th>Name</th></tr>} rows={rows} tabs={null} total={total} />,
  );

describe('roster windowing', () => {
  it('mounts only the first 25 of a long roster', () => {
    const html = render(make(60));
    expect(html).toContain('Player 000');
    expect(html).toContain('Player 024');
    // 025 is the first row past the window and must NOT be in the document.
    expect(html).not.toContain('Player 025');
    expect(html).not.toContain('Player 059');
  });

  it('says how many are left rather than implying the list is complete', () => {
    const html = render(make(60));
    expect(html).toContain('Show more');
    expect(html).toContain('35 left');
    // Mounted, then matched. Not "60 of 60".
    expect(html).toMatch(/Showing\s*25\s*of\s*60/);
  });

  it('does not window a roster that already fits, and adds no button', () => {
    const html = render(make(10));
    expect(html).toContain('Player 009');
    expect(html).not.toContain('Show more');
    expect(html).toMatch(/Showing\s*10\s*of\s*10/);
  });

  it('surfaces the 500-row query cap instead of hiding it behind the window', () => {
    // What the page passes when a tab holds more than the list query fetched:
    // 500 rows in hand, 620 in the tab. The window must not make that read as
    // "25 of 25" — the cap is the one thing the reader cannot otherwise see.
    const html = render(make(500), 620);
    expect(html).toMatch(/Showing\s*25\s*of\s*500/);
    expect(html).toContain('620 in tab');
  });
});
