import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// THE CLUB LINKS IN THE CHROME, through a real render. The layout decides once
// whether Discord is shown (the socials switch and club_socials.show_discord)
// and hands the answer down; these check that each piece of chrome obeys it,
// and that the signed-out Membership link follows its own switch.

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));

import { TopBar } from '../top-bar';
import { LegalFooter } from '../legal-footer';
import { ALL_FEATURES_ENABLED } from '@badminton/shared/src/utils/features';

const INVITE = 'https://discord.sfubadminton.com';
const IG = 'https://www.instagram.com/sfu_badmintonclub/';

const topBar = (props: Partial<Parameters<typeof TopBar>[0]> = {}) =>
  renderToStaticMarkup(
    <TopBar playerName="" unreadCount={0} isAuthenticated={false} isExecOrAdmin={false} {...props} />,
  );

describe('the top bar', () => {
  it('offers a signed-out visitor Membership and Discord', () => {
    const html = topBar();
    expect(html).toContain('href="/membership"');
    expect(html).toContain(INVITE);
  });

  it('drops Discord when the layout says not to show it, signed out and signed in', () => {
    expect(topBar({ showDiscord: false })).not.toContain(INVITE);
    expect(topBar({ isAuthenticated: true, playerName: 'A Member', showDiscord: false })).not.toContain(INVITE);
    expect(topBar({ isAuthenticated: true, playerName: 'A Member' })).toContain(INVITE);
  });

  it('drops the signed-out Membership link when the membership switch is off', () => {
    expect(topBar({ features: { ...ALL_FEATURES_ENABLED, membership: false } })).not.toContain('href="/membership"');
  });
});

describe('the footer', () => {
  it('draws no socials row while the socials switch is off', () => {
    const html = renderToStaticMarkup(<LegalFooter socials={null} />);
    expect(html).not.toContain('All socials');
    expect(html).not.toContain(INVITE);
  });

  it('draws Discord, Instagram and a link to /socials', () => {
    const html = renderToStaticMarkup(<LegalFooter socials={{ showDiscord: true, instagramUrl: IG }} />);
    expect(html).toContain(INVITE);
    expect(html).toContain(IG);
    expect(html).toContain('href="/socials"');
  });

  it('hides each link on its own, and the row when nothing is left', () => {
    const noDiscord = renderToStaticMarkup(<LegalFooter socials={{ showDiscord: false, instagramUrl: IG }} />);
    expect(noDiscord).not.toContain(INVITE);
    expect(noDiscord).toContain(IG);
    const nothing = renderToStaticMarkup(<LegalFooter socials={{ showDiscord: false, instagramUrl: null }} />);
    expect(nothing).not.toContain('All socials');
  });
});
