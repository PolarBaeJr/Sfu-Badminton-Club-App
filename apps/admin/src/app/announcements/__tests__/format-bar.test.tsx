import { describe, expect, it } from 'vitest';
import { FORMAT_BUTTONS, type FormatSurface } from '../format-bar';

/**
 * The button set per box, pinned.
 *
 * This is the test that makes the website's set a DECISION rather than an
 * oversight: a later "make the two tabs match" edit has to argue with a failing
 * assertion instead of quietly adding a spoiler button to a page that cannot
 * draw a spoiler, or a link button whose markup the player renderer refuses to
 * turn into an anchor (it emits none, because the feed card wraps the body in a
 * `<Link>`).
 */
const on = (surface: FormatSurface) =>
  FORMAT_BUTTONS.filter((b) => b.surfaces.includes(surface)).map((b) => b.title);

const SHARED = [
  'Bold',
  'Italic',
  'Underline',
  'Strikethrough',
  'Inline code',
  'Heading',
  'Quote',
  'Bullet list',
];

describe('FORMAT_BUTTONS, per surface', () => {
  it('offers exactly the eight web-safe buttons on the website body', () => {
    expect(on('website')).toEqual(SHARED);
  });

  it('offers neither the spoiler nor the link on the website body', () => {
    const website = on('website');

    expect(website).not.toContain('Spoiler, hidden until clicked');
    expect(website).not.toContain('Link, renders in an embed only');
  });

  it('keeps the spoiler on both Discord shapes', () => {
    expect(on('message')).toContain('Spoiler, hidden until clicked');
    expect(on('embed')).toContain('Spoiler, hidden until clicked');
  });

  it('keeps the masked link on the embed alone, where Discord draws it', () => {
    expect(on('embed')).toContain('Link, renders in an embed only');
    expect(on('message')).not.toContain('Link, renders in an embed only');
  });

  it('names a surface for every button, so none can be silently unreachable', () => {
    for (const button of FORMAT_BUTTONS) {
      expect(button.surfaces.length).toBeGreaterThan(0);
    }
  });
});
