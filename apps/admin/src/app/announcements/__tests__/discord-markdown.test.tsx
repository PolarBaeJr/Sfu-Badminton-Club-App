import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DISCORD_MENTION_BG,
  DiscordMarkdown,
} from '../discord-markdown';
import type { DiscordRoleOption } from '../announcement-shape';

/**
 * The facsimile, checked through a real render rather than by re-deriving the
 * tokeniser in the test.
 *
 * renderToStaticMarkup and not a DOM: this app's vitest runs `environment:
 * 'node'` and carries neither jsdom nor testing-library, exactly as
 * `players/__tests__/roster-window.test.tsx` explains. What a server render
 * cannot exercise is the spoiler's hover, so that one is asserted on the class
 * that carries it.
 *
 * TWO HALVES HERE, and the second is the one that matters most. One assertion
 * per ENABLED construct says the preview draws what Discord draws; one per
 * DISABLED construct says the preview shows the literal characters rather than
 * half-rendering syntax nothing in this console can produce.
 */
const ROLES: DiscordRoleOption[] = [{ id: '333333333333333333', name: 'executives' }];

const draw = (text: string) => renderToStaticMarkup(<DiscordMarkdown text={text} roles={ROLES} />);

describe('DiscordMarkdown, the constructs that render', () => {
  it('draws a known role id as a named chip', () => {
    const html = draw('Ask <@&333333333333333333> about it.');

    expect(html).toContain('@executives');
    expect(html).toContain(DISCORD_MENTION_BG);
    // The snowflake itself never reaches the screen, which is the whole bug.
    expect(html).not.toContain('333333333333333333');
  });

  it('draws an id it cannot name as a chip anyway, never as the raw id', () => {
    // Discord draws a chip from the id alone, so a chip is shape-honest here and
    // eighteen digits are not. The realistic unknown is a live self-assign role.
    const html = draw('Ask <@&777777777777777777> about it.');

    expect(html).toContain('@role');
    expect(html).toContain(DISCORD_MENTION_BG);
    expect(html).not.toContain('777777777777777777');
  });

  it('renders a mention the description slice cut in half as the characters it now is', () => {
    // `announcementEmbed` slices AFTER the resolve, so a body near the cap can
    // lose the closing `>`. A chip built from half an id would be a lie about
    // both the layout and the length.
    const html = draw('Ask <@&33333333');

    expect(html).not.toContain(DISCORD_MENTION_BG);
    expect(html).toContain('33333333');
  });

  it('draws bold, italic, underline and strikethrough', () => {
    expect(draw('**loud**')).toContain('<strong>loud</strong>');
    expect(draw('*quiet*')).toContain('<em>quiet</em>');
    expect(draw('_quiet_')).toContain('<em>quiet</em>');
    expect(draw('__lined__')).toContain('<u>lined</u>');
    expect(draw('~~gone~~')).toContain('<s>gone</s>');
  });

  it('draws inline code, and the code wins over everything inside it', () => {
    const html = draw('run `**stars**` here');

    expect(html).toContain('<code');
    // Discord's own rule: backticks beat the markup between them.
    expect(html).toContain('**stars**');
    expect(html).not.toContain('<strong>');
  });

  it('keeps a role id literal inside inline code', () => {
    // The one case where showing the snowflake is the correct answer.
    const html = draw('the raw form is `<@&333333333333333333>`');

    expect(html).toContain('333333333333333333');
    expect(html).not.toContain(DISCORD_MENTION_BG);
  });

  it('draws a spoiler hidden, and reveals it on hover', () => {
    const html = draw('||the answer||');

    expect(html).toContain('the answer');
    expect(html).toContain('text-transparent');
    // Asserted on the class because a node render has no hover to trigger.
    expect(html).toContain('hover:text-[#dbdee1]');
  });

  it('draws all three heading levels', () => {
    expect(draw('# Big')).toContain('<h1');
    expect(draw('## Middle')).toContain('<h2');
    expect(draw('### Small')).toContain('<h3');
    expect(draw('## Middle')).toContain('Middle');
  });

  it('draws consecutive bullets as one list, from either marker', () => {
    const html = draw('- first\n* second');

    expect(html).toContain('<ul');
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('draws consecutive quote lines as one quote', () => {
    const html = draw('> first\n> second');

    expect(html).toContain('border-left');
    expect(html).toContain('first\nsecond');
  });

  it('draws a fenced block, and leaves an unterminated fence as ordinary lines', () => {
    expect(draw('```\nnpm run it\n```')).toContain('<pre');

    // The option that cannot invent structure out of a half-typed body: the
    // alternative is that opening a fence silently swallows the rest of the post.
    const half = draw('```\nnpm run it');
    expect(half).not.toContain('<pre');
    expect(half).toContain('```');
  });

  it('draws a masked link, and a bare https run', () => {
    const masked = draw('[the page](https://example.com)');
    expect(masked).toContain('href="https://example.com"');
    expect(masked).toContain('the page');
    expect(masked).toContain('rel="noreferrer noopener"');
    expect(masked).toContain('target="_blank"');

    expect(draw('see https://example.com now')).toContain('href="https://example.com"');
  });

  it('leaves the punctuation that ends a sentence out of the link', () => {
    const html = draw('see https://example.com.');
    expect(html).toContain('href="https://example.com"');
  });
});

describe('DiscordMarkdown, the security boundary', () => {
  it('escapes markup rather than rendering it', () => {
    // React escapes every text child, which is why there is no
    // dangerouslySetInnerHTML anywhere in that file.
    const html = draw('<script>alert(1)</script>');

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a link target outside http and https', () => {
    // THE SCHEME ALLOWLIST, not React, is the defence: React's handling of a
    // `javascript:` href is version-dependent.
    for (const target of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com']) {
      const html = draw(`[click](${target})`);
      expect(html).not.toContain('<a');
      expect(html).toContain('[click]');
    }
  });

  it('does not autolink a scheme it would refuse in an href', () => {
    // One rule for both paths, so neither can drift into linking what the other
    // rejects.
    expect(draw('ftp://example.com')).not.toContain('<a');
  });
});

describe('DiscordMarkdown, the constructs deliberately left as text', () => {
  it('leaves @everyone and @here as plain words', () => {
    // Neither can notify from inside an embed, and the forward scanner never
    // rewrites them either.
    const html = draw('@everyone and @here');

    expect(html).toContain('@everyone and @here');
    expect(html).not.toContain(DISCORD_MENTION_BG);
  });

  it('leaves user, channel and timestamp syntax as the characters typed', () => {
    // All three are real Discord syntax that nothing in this console produces,
    // and there is no map here to name a user or a channel from.
    const html = draw('<@444444444444444444> in <#555555555555555555> at <t:1700000000:t>');

    expect(html).toContain('444444444444444444');
    expect(html).toContain('555555555555555555');
    expect(html).toContain('1700000000');
    expect(html).not.toContain(DISCORD_MENTION_BG);
  });

  it('leaves subtext, block quotes and nested lists as the characters typed', () => {
    expect(draw('-# quietly')).toContain('-# quietly');
    expect(draw('>>> everything below')).toContain('&gt;&gt;&gt; everything below');

    const nested = draw('- top\n  - under');
    expect(nested.match(/<ul/g)).toHaveLength(1);
    expect(nested).toContain('- under');
  });
});
