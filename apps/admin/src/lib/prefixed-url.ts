// The fixed prefix drawn beside a URL input on Club links, so an officer types
// only the part that changes. The stored value is always the FULL URL: the
// input shows `rest`, and every keystroke is joined back before it reaches the
// form's state, so saving, the Modified check and the server's own validation
// see exactly what they saw before.
//
// A stored value the prefix cannot represent exactly (an http:// link, an
// Instagram URL without the www or with a query) falls back to a plain input
// showing the whole URL, rather than being silently rewritten.
//
// Pure: no React, so the tests need no DOM.

export type Adornment = 'https' | 'instagram';

export const ADORNMENT_PREFIX: Record<Adornment, string> = {
  https: 'https://',
  instagram: 'instagram.com/',
};

export type AdornedSplit = { mode: 'adorned'; rest: string } | { mode: 'plain' };

const INSTAGRAM_CANONICAL = /^https:\/\/www\.instagram\.com\/([^/?#\s]+)\/$/;

export function splitAdorned(kind: Adornment, stored: string): AdornedSplit {
  if (stored === '') return { mode: 'adorned', rest: '' };
  if (kind === 'https') {
    return stored.startsWith('https://') ? { mode: 'adorned', rest: stored.slice('https://'.length) } : { mode: 'plain' };
  }
  const match = INSTAGRAM_CANONICAL.exec(stored);
  return match ? { mode: 'adorned', rest: match[1]! } : { mode: 'plain' };
}

/** What the adorned input typed, as the full URL to store. Empty stays empty. */
export function joinAdorned(kind: Adornment, typed: string): string {
  if (typed === '') return '';
  if (kind === 'https') return `https://${typed.replace(/^https?:\/\//i, '')}`;
  const handle = typed
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
  return handle === '' ? '' : `https://www.instagram.com/${handle}/`;
}
