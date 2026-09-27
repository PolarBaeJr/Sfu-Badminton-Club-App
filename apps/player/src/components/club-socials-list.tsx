import { DISCORD_INVITE_URL } from '@badminton/shared';
import type { ClubSocials } from '@badminton/shared';

// The club's links as rows, for /socials and the block on /membership. A
// server component: the caller has already read the links and decided the
// socials switch is on.
//
// Discord links to the club's own subdomain, never a discord.gg code, so the
// invite can rotate without a release (see DISCORD_INVITE_URL).

/** True when there is at least one link to draw. */
export function hasClubSocials(socials: ClubSocials): boolean {
  return socials.showDiscord || socials.instagramUrl !== null;
}

export function ClubSocialsList({ socials }: { socials: ClubSocials }) {
  return (
    <>
      {socials.showDiscord && (
        <div className="fees-price">
          <div className="fees-price-main">
            <div className="fees-price-name">Discord</div>
            <div className="fees-price-note">Session pings, results and the club chat</div>
          </div>
          <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            Join
          </a>
        </div>
      )}
      {socials.instagramUrl && (
        <div className="fees-price">
          <div className="fees-price-main">
            <div className="fees-price-name">Instagram</div>
            <div className="fees-price-note">Photos and announcements</div>
          </div>
          <a href={socials.instagramUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            Follow
          </a>
        </div>
      )}
    </>
  );
}
