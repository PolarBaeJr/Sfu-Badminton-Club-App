import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The season label in the app chrome, checked through a real render.
 *
 * WHY THIS EXISTS: the top bar renders above EVERY page, and in the App Router a
 * layout never receives searchParams — only a page does. So the label had no way
 * to learn that the screen under it was a finished term, and went on printing the
 * ACTIVE season's name over a past one. A member looking at Summer 2026 saw
 * "Fall 2026" in the chrome above it.
 *
 * `next/navigation` is mocked because this app's vitest runs `environment:
 * 'node'` with no DOM and no router, so the hooks have nothing to read. That is
 * the same posture ladder-row.test.tsx explains, and vi.mock is used in 94 files
 * across this repo. `vi.hoisted` because a vi.mock factory is hoisted above the
 * imports and cannot close over an ordinary const.
 */
const state = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/my-stats',
  useSearchParams: () => new URLSearchParams(state.search),
}));

import { TopBar } from '../top-bar';

// The two real season ids from the local stack, so the fixture matches what the
// picker actually puts in the URL rather than a shape invented for the test.
const ACTIVE_ID = 'd0a3f925-12a4-41f2-8a2f-010821676637';
const PAST_ID = '15af1db0-ac97-499d-b583-98082a921368';

const draw = (search: string) => {
  state.search = search;
  return renderToStaticMarkup(
    <TopBar
      playerName="Wui Ki Cheng"
      unreadCount={0}
      isAuthenticated
      isExecOrAdmin={false}
      activeSeasonName="Fall 2026"
      activeSeasonId={ACTIVE_ID}
    />
  );
};

describe('the season label in the app chrome', () => {
  it('names the active season when no season is being viewed', () => {
    const html = draw('');
    expect(html).toContain('Fall 2026');
    expect(html).not.toContain('PAST SEASON');
  });

  it('stops naming the active season while a finished term is on screen', () => {
    const html = draw(`season=${PAST_ID}`);
    expect(html).toContain('PAST SEASON');
    expect(html).not.toContain('Fall 2026');
  });

  /**
   * THE CONTROL, and the one that fails a lazy fix.
   *
   * `?season=` pointing AT the active season is the current term, reached by
   * picking "Fall 2026 · now" out of the picker, and the chrome must still name
   * it. A guard written on the mere PRESENCE of the parameter passes both tests
   * above and fails here.
   */
  it('still names the season when the parameter points at the active one', () => {
    const html = draw(`season=${ACTIVE_ID}`);
    expect(html).toContain('Fall 2026');
    expect(html).not.toContain('PAST SEASON');
  });
});
