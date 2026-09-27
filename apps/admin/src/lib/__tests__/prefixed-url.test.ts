import { describe, it, expect } from 'vitest';
import { DEFAULT_INSTAGRAM_URL } from '@badminton/shared/src/utils/club-socials';
import { DEFAULT_MEMBERSHIP_PURCHASE_URL } from '@badminton/shared/src/utils/membership-settings';
import { joinAdorned, splitAdorned, type Adornment } from '../prefixed-url';

// The stored value is always the full URL. A default that did not round-trip
// would mark the field Modified the moment an officer typed and deleted a
// character, and a doubled prefix would save a broken link.

function roundTrip(kind: Adornment, stored: string): string {
  const split = splitAdorned(kind, stored);
  if (split.mode !== 'adorned') throw new Error(`${stored} fell back to plain`);
  return joinAdorned(kind, split.rest);
}

describe('https adornment', () => {
  it('round-trips the default buy link and an empty one', () => {
    expect(roundTrip('https', DEFAULT_MEMBERSHIP_PURCHASE_URL)).toBe(DEFAULT_MEMBERSHIP_PURCHASE_URL);
    expect(splitAdorned('https', '')).toEqual({ mode: 'adorned', rest: '' });
    expect(joinAdorned('https', '')).toBe('');
  });

  it('does not double a pasted prefix', () => {
    expect(joinAdorned('https', 'https://example.com/buy')).toBe('https://example.com/buy');
    expect(joinAdorned('https', 'http://example.com/buy')).toBe('https://example.com/buy');
    expect(joinAdorned('https', 'example.com/buy')).toBe('https://example.com/buy');
  });

  it('shows an http:// link whole rather than rewriting it', () => {
    expect(splitAdorned('https', 'http://example.com')).toEqual({ mode: 'plain' });
  });
});

describe('instagram adornment', () => {
  it('round-trips the default profile and an empty one', () => {
    expect(roundTrip('instagram', DEFAULT_INSTAGRAM_URL)).toBe(DEFAULT_INSTAGRAM_URL);
    expect(splitAdorned('instagram', DEFAULT_INSTAGRAM_URL)).toEqual({ mode: 'adorned', rest: 'sfu_badmintonclub' });
    expect(splitAdorned('instagram', '')).toEqual({ mode: 'adorned', rest: '' });
    expect(joinAdorned('instagram', '')).toBe('');
  });

  it('turns a handle, an @handle or a pasted URL into the canonical profile link', () => {
    const canonical = 'https://www.instagram.com/club/';
    for (const typed of ['club', '@club', 'club/', 'instagram.com/club', 'https://www.instagram.com/club/', 'https://instagram.com/club']) {
      expect(joinAdorned('instagram', typed), typed).toBe(canonical);
    }
  });

  it('shows a non-canonical stored link whole rather than rewriting it', () => {
    expect(splitAdorned('instagram', 'https://instagram.com/club/')).toEqual({ mode: 'plain' });
    expect(splitAdorned('instagram', 'https://www.instagram.com/club')).toEqual({ mode: 'plain' });
    expect(splitAdorned('instagram', 'http://www.instagram.com/club/')).toEqual({ mode: 'plain' });
  });
});
