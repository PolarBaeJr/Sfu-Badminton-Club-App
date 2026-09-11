import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscordPreview, type DiscordPreviewProps } from '../discord-preview';
import { DISCORD_MENTION_BG } from '../discord-markdown';

/**
 * The preview, and specifically the one question it is asked twice with two
 * different right answers.
 *
 * renderToStaticMarkup for the reason `discord-markdown.test.tsx` gives: this
 * app's vitest is `environment: 'node'`.
 */
const BASE: DiscordPreviewProps = {
  title: 'Courts are closed',
  body: '',
  type: 'info',
  targetAudience: 'all',
  expiresAt: null,
  status: 'published',
  channelConfigured: true,
  url: null,
  posted: null,
  updatedAt: null,
  roles: [{ id: '333333333333333333', name: 'executives' }],
  resolvesRoleNames: false,
  buttonSet: null,
};

const draw = (props: Partial<DiscordPreviewProps>) =>
  renderToStaticMarkup(<DiscordPreview {...BASE} {...props} />);

describe('DiscordPreview', () => {
  /**
   * THE ASYMMETRY, which is the most regression-prone behaviour in the whole
   * change: one body, two call sites, two different truths.
   *
   * The Discord composer's message goes through `resolveForDiscord`, so a chip is
   * what the channel gets. A website announcement is posted by the relay exactly
   * as stored, so grey text is what the channel gets. Both assertions look for
   * the CHIP rather than for the name, because the name is present either way
   * and a test that only checked it would pass in both directions and prove
   * nothing.
   */
  it('chips a role name only on the path that resolves one', () => {
    const body = 'Ask @executives about it.';

    const chipped = draw({ body, resolvesRoleNames: true });
    expect(chipped).toContain('@executives');
    expect(chipped).toContain(DISCORD_MENTION_BG);
    expect(chipped).not.toContain('333333333333333333');

    const plain = draw({ body, resolvesRoleNames: false });
    expect(plain).toContain('@executives');
    expect(plain).not.toContain(DISCORD_MENTION_BG);
  });

  it('leaves the headline flat, markers and mention alike', () => {
    // An embed title renders no markdown and resolves no mention, so the
    // asterisks and the id really do reach Discord as themselves.
    const html = draw({
      title: '**Closed** <@&333333333333333333>',
      resolvesRoleNames: true,
    });

    expect(html).toContain('**Closed**');
    expect(html).toContain('333333333333333333');
    expect(html).not.toContain(DISCORD_MENTION_BG);
  });

  it('still says what the relay will do', () => {
    expect(draw({ body: 'Doors at seven.' })).toContain(
      'Will appear in the Discord channel within five minutes.',
    );
  });

  it('still warns that Discord will not take a body this long', () => {
    const html = draw({ body: 'x'.repeat(4001) });

    expect(html).toContain('The website shows all of it.');
  });

  /**
   * THE SECOND ASYMMETRY, and the reason `buttonSet` is required with no
   * default: the Discord composer can carry the member buttons and the website
   * composer never can, because a relayed announcement goes out through a path
   * with no column to put them in.
   */
  it('draws the member buttons only for a message that carries them', () => {
    const withButtons = draw({ buttonSet: 'guide' });
    for (const label of ['Connect my account', 'Report a bug', 'Send feedback']) {
      expect(withButtons).toContain(label);
    }
    expect(withButtons).toContain('replies only to them');

    const without = draw({ buttonSet: null });
    expect(without).not.toContain('Connect my account');
    expect(without).not.toContain('replies only to them');
  });

  it('draws only the one button a narrow set names', () => {
    // EACH GUIDE IS ABOUT ONE TASK (00228), and the whole point of the preview
    // here is that somebody can see the message carries that button and not the
    // other two before they edit six real messages in the channel.
    const html = draw({ buttonSet: 'bug' });

    expect(html).toContain('Report a bug');
    expect(html).not.toContain('Connect my account');
    expect(html).not.toContain('Send feedback');
    expect(html).toContain('replies only to them');
  });

  it('draws nothing for a set name the console does not know', () => {
    // The bot resolves an unknown name to no components at all, so a guessed
    // row of pills here would be a picture of something nobody will ever see.
    expect(draw({ buttonSet: 'rolepicker' })).not.toContain('Connect my account');
  });
});
