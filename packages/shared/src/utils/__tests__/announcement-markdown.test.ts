import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_PREVIEW_MAX,
  stripAnnouncementMarkdown,
} from '../announcement-markdown';

/**
 * The plain-text leg, which is the one real regression the markdown change could
 * have shipped: the bell row and the lock-screen push render nothing, so the
 * markers have to come off before either sees the string.
 */
describe('stripAnnouncementMarkdown', () => {
  it('drops the paired markers and keeps the words', () => {
    expect(stripAnnouncementMarkdown('**Courts closed** on *Friday*')).toBe(
      'Courts closed on Friday',
    );
    expect(stripAnnouncementMarkdown('__lined__ and ~~gone~~')).toBe('lined and gone');
    expect(stripAnnouncementMarkdown('type `npm test` here')).toBe('type npm test here');
  });

  it('drops the line-leading markers', () => {
    expect(stripAnnouncementMarkdown('## Heading')).toBe('Heading');
    expect(stripAnnouncementMarkdown('# One\n### Three')).toBe('One\nThree');
    expect(stripAnnouncementMarkdown('- a\n* b')).toBe('a\nb');
    expect(stripAnnouncementMarkdown('> quoted')).toBe('quoted');
  });

  it('leaves a single underscore alone, so it cannot drift from the renderer', () => {
    // apps/player/src/lib/announcement-markdown.tsx deliberately does not
    // italicise `_text_`, because `some_file_name.pdf` is ordinary content.
    // Stripping it here would make the bell row and the page disagree.
    expect(stripAnnouncementMarkdown('read some_file_name.pdf')).toBe('read some_file_name.pdf');
    expect(stripAnnouncementMarkdown('_this_')).toBe('_this_');
  });

  it('leaves an unclosed marker alone, exactly as the renderer does', () => {
    expect(stripAnnouncementMarkdown('**unclosed')).toBe('**unclosed');
    expect(stripAnnouncementMarkdown('*a\n*b')).toBe('*a\n*b');
  });

  it('gives a 140-character preview with no markers left in it', () => {
    // STRIP FIRST, THEN SLICE. The ordering is the whole point: slicing a bold
    // body first can cut a `**` in half, and nothing downstream can recover it.
    const body = `**${'word '.repeat(60).trim()}**`;
    expect(body.length).toBeGreaterThan(300);

    const plain = stripAnnouncementMarkdown(body);
    const preview =
      plain.length > ANNOUNCEMENT_PREVIEW_MAX
        ? `${plain.slice(0, ANNOUNCEMENT_PREVIEW_MAX - 1)}…`
        : plain;

    expect(preview).toHaveLength(ANNOUNCEMENT_PREVIEW_MAX);
    expect(preview).not.toContain('*');
  });
});
