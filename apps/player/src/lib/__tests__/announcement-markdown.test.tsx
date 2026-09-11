import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnnouncementMarkdown } from '../announcement-markdown';

/**
 * The renderer, checked through a real render rather than by re-deriving the
 * tokeniser in the test.
 *
 * renderToStaticMarkup and not a DOM: this app's vitest runs `environment:
 * 'node'` and carries neither jsdom nor testing-library, the same posture the
 * console's discord-markdown test explains.
 *
 * TWO HALVES, and the second matters most. One assertion per construct says the
 * page draws what the composer's toolbar writes. The rest pin the deliberate
 * divergences from that Discord facsimile, above all that this renderer emits no
 * anchor: the feed's CLUB NOTICE body sits inside a `<Link>`, so an `<a>` here
 * would be an anchor nested in an anchor.
 */
const draw = (text: string) => renderToStaticMarkup(<AnnouncementMarkdown text={text} />);

describe('AnnouncementMarkdown, the constructs that render', () => {
  it('draws bold, italic, underline and strikethrough', () => {
    expect(draw('**loud**')).toContain('<strong>loud</strong>');
    expect(draw('*quiet*')).toContain('<em>quiet</em>');
    expect(draw('__lined__')).toContain('<u>lined</u>');
    expect(draw('~~gone~~')).toContain('<s>gone</s>');
  });

  it('draws inline code, and leaves the markers inside it alone', () => {
    const html = draw('type `**not bold**` in the box');

    expect(html).toContain('<code');
    expect(html).toContain('**not bold**');
  });

  it('maps the three heading levels onto h3, h4 and h5', () => {
    // NOT h1..h3: the post's own title is already the h2 beside this body.
    expect(draw('# One')).toContain('<h3');
    expect(draw('## Two')).toContain('<h4');
    expect(draw('### Three')).toContain('<h5');
    expect(draw('# One')).not.toContain('<h1');
    expect(draw('## Two')).not.toContain('<h2');
  });

  it('collapses a run of bullets into one list, with a visible marker', () => {
    // `- ` and `* ` are both bullets, and Preflight zeroes the list style, so the
    // renderer has to state it or the run draws as unindented lines.
    const html = draw('- a\n* b');

    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('list-style-type');
  });

  it('collapses consecutive quote lines into one block', () => {
    const html = draw('> first\n> second');

    expect(html.match(/border-left/g)).toHaveLength(1);
    expect(html).toContain('first\nsecond');
  });

  it('draws a closed fence as a pre block', () => {
    expect(draw('```\ncode here\n```')).toContain('<pre');
  });

  it('keeps a single newline, which is why the paragraph block is pre-wrap', () => {
    const html = draw('one\ntwo');

    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('one\ntwo');
  });
});

describe('AnnouncementMarkdown, the deliberate divergences', () => {
  it('NEVER emits an anchor, for any input', () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. The feed card wraps this body
    // in a <Link>, so an anchor here nests one inside another.
    for (const input of [
      '[label](https://example.com)',
      'see https://example.com for more',
      '<a href="https://example.com">x</a>',
      'mail me at first_last@sfu.ca',
    ]) {
      expect(draw(input)).not.toContain('<a');
    }
  });

  it('leaves a single underscore literal rather than italicising it', () => {
    // `some_file_name.pdf` is ordinary announcement content. The console's
    // Discord facsimile does take `_text_`; this renderer deliberately does not.
    const html = draw('read some_file_name.pdf and _this_ too');

    expect(html).toContain('some_file_name.pdf');
    expect(html).toContain('_this_');
    expect(html).not.toContain('<em>');
  });

  it('leaves a spoiler as the pipes typed', () => {
    // No spoiler button is offered on the website surface, and there is nothing
    // to click to reveal one on a page.
    const html = draw('||hidden||');

    expect(html).toContain('||hidden||');
  });

  it('escapes markup somebody types into the composer', () => {
    const html = draw('<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows an unclosed marker as the characters typed', () => {
    const html = draw('**unclosed');

    expect(html).toContain('**unclosed');
    expect(html).not.toContain('<strong>');
  });

  it('refuses a wrapper that would span a newline', () => {
    // Two footnote lines in one paragraph run, each starting with a `*`. The gap
    // between them is not italics.
    const html = draw('*a\n*b');

    expect(html).not.toContain('<em>');
    expect(html).toContain('*a\n*b');
  });

  it('refuses a stray backtick, rather than swallowing the rest of the post', () => {
    const html = draw('press ` to open\nand the post carries on');

    expect(html).not.toContain('<code');
    expect(html).toContain('and the post carries on');
  });
});

describe('AnnouncementMarkdown, the wrapper', () => {
  it('supplies exactly one div, carrying the caller class', () => {
    // ONE wrapper: a caller writing <div className="news-body"><Announcement...
    // would nest two, putting the class margin on the outer and pre-wrap inside.
    const html = renderToStaticMarkup(
      <AnnouncementMarkdown text="plain" className="news-body" />,
    );

    expect(html.startsWith('<div class="news-body">')).toBe(true);
  });
});
