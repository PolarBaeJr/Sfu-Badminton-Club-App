import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INSTAGRAM_URL,
  defaultClubSocialsValue,
  parseClubSocials,
  safeInstagramUrl,
} from '../club-socials';

describe('safeInstagramUrl', () => {
  it('accepts a profile on www.instagram.com and on the bare host', () => {
    expect(safeInstagramUrl('https://www.instagram.com/sfubadminton/')).toBe(
      'https://www.instagram.com/sfubadminton/',
    );
    expect(safeInstagramUrl(' https://instagram.com/sfubadminton ')).toBe('https://instagram.com/sfubadminton');
  });

  it.each([
    'javascript:alert(1)',
    'http://www.instagram.com/sfubadminton/',
    'https://evil.com/sfubadminton',
    'https://instagram.com.evil.com/x',
    'https://user:pw@www.instagram.com/x',
    'https://www.instagram.com:8443/x',
    'data:text/html,hi',
    'not a url',
    '',
    '   ',
  ])('rejects %s', (raw) => {
    expect(safeInstagramUrl(raw)).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(safeInstagramUrl(42)).toBeNull();
    expect(safeInstagramUrl(null)).toBeNull();
  });
});

describe('parseClubSocials', () => {
  it('seeds the club profile, which passes its own rule', () => {
    expect(defaultClubSocialsValue()).toEqual({ instagram_url: DEFAULT_INSTAGRAM_URL, show_discord: true });
    expect(safeInstagramUrl(DEFAULT_INSTAGRAM_URL)).toBe(DEFAULT_INSTAGRAM_URL);
  });

  it('reads an absent or malformed row as the defaults', () => {
    const defaults = { instagramUrl: DEFAULT_INSTAGRAM_URL, showDiscord: true };
    expect(parseClubSocials(null)).toEqual(defaults);
    expect(parseClubSocials(undefined)).toEqual(defaults);
    expect(parseClubSocials([])).toEqual(defaults);
    expect(parseClubSocials('x')).toEqual(defaults);
    expect(parseClubSocials({})).toEqual(defaults);
  });

  it('reads a stored row', () => {
    expect(parseClubSocials({ instagram_url: 'https://instagram.com/other', show_discord: true })).toEqual({
      instagramUrl: 'https://instagram.com/other',
      showDiscord: true,
    });
  });

  it('hides Instagram on an explicit blank, and on a stored value that fails the rule', () => {
    expect(parseClubSocials({ instagram_url: '' }).instagramUrl).toBeNull();
    expect(parseClubSocials({ instagram_url: 'javascript:alert(1)' }).instagramUrl).toBeNull();
    expect(parseClubSocials({ instagram_url: 5 }).instagramUrl).toBeNull();
  });

  it('hides Discord only on a literal false', () => {
    expect(parseClubSocials({ show_discord: false }).showDiscord).toBe(false);
    expect(parseClubSocials({ show_discord: 'false' }).showDiscord).toBe(true);
    expect(parseClubSocials({ show_discord: null }).showDiscord).toBe(true);
  });
});
