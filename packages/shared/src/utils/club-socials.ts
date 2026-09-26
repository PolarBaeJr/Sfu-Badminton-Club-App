// THE CLUB'S SOCIAL LINKS, as one platform_settings row, key `club_socials`:
//
//   instagram_url  the club's Instagram profile; '' hides Instagram
//   show_discord   false hides every link to the club Discord on the site and
//                  in the bot's /socials reply
//
// Edited on /accounts by the generic settings form. No migration seeds the
// row: an absent row, or an absent field, reads as the default below, the
// same way an absent `features` row reads as everything on. An explicit ''
// or false is what hides a link.
//
// Every reader re-applies the rules below rather than trusting what was
// stored. The write path checks them too, but a row edited by hand in SQL, or
// saved before a rule existed, must not put a javascript: link in the footer
// of every page.
//
// Dependency-free, so a client component, a server page and a test can all
// import it deeply.

export const CLUB_SOCIALS_SETTING_KEY = 'club_socials';

export const DEFAULT_INSTAGRAM_URL = 'https://www.instagram.com/sfu_badmintonclub/';

/** The row a first save starts from, and what an absent row stands for. */
export function defaultClubSocialsValue(): { instagram_url: string; show_discord: boolean } {
  return { instagram_url: DEFAULT_INSTAGRAM_URL, show_discord: true };
}

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);

export interface ClubSocials {
  instagramUrl: string | null;
  showDiscord: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * An Instagram link the site is willing to print: https, on instagram.com, no
 * credentials, no port. Returns the URL as normalised by the parser, or null.
 */
export function safeInstagramUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  return url.toString();
}

/**
 * The stored row as what the site may show. Never throws. An absent field is
 * its default; only a literal `false` hides Discord, and a stored value that
 * fails the Instagram rule hides Instagram rather than falling back.
 */
export function parseClubSocials(value: unknown): ClubSocials {
  const row = asRecord(value);
  const defaults = defaultClubSocialsValue();
  const instagram = Object.hasOwn(row, 'instagram_url') ? row.instagram_url : defaults.instagram_url;
  return {
    instagramUrl: safeInstagramUrl(instagram),
    showDiscord: row.show_discord !== false,
  };
}
