// The club's handle list, cached, for the /profile picker.
//
// ---- WHY THIS IS NOT config.ts ----
//
// The failure policy is the opposite one. A stale role map makes the sweep act
// on the wrong roles, so config.ts would rather throw than guess; a stale handle
// list only means a member who joined in the last few minutes is not suggested
// yet, and they can still be found by typing their handle in full. So every
// failure here degrades to the last good copy, or to nothing, and never to an
// error the member sees.
//
// It also carries traffic config.ts does not. An autocomplete fires on every
// keystroke, so the cache is what stands between one member typing a handle and
// a dozen requests to the app.

import { fetchHandles, type ClubHandle } from './api.js';

// Longer than config's minute. A handle changes on the order of never, and the
// cost of being stale is one new member missing from the suggestions.
const CACHE_TTL_MS = 5 * 60_000;

// Discord refuses an autocomplete response carrying more than this — the whole
// response, not the surplus rows.
const MAX_CHOICES = 25;

let cached: { value: ClubHandle[]; at: number } | null = null;

// The refresh in flight, if there is one. config.ts has no equivalent and can
// double-fetch, which is harmless at its call rate; here a member typing eight
// characters into a cold picker would otherwise open eight identical requests.
//
// HOLDS THE ALREADY-SAFE PROMISE, never the raw fetch. A joiner that has walked
// away — the loser of the race in index.ts does exactly that — would otherwise
// be left holding a rejection nobody handles, and this process has no top-level
// catch to absorb it.
let inFlight: Promise<ClubHandle[]> | null = null;

/** Test seam, mirroring invalidateConfigCache. */
export function invalidateHandleCache(): void {
  cached = null;
  inFlight = null;
}

async function refresh(log: (line: string) => void, now: () => number): Promise<ClubHandle[]> {
  try {
    const { members } = await fetchHandles();
    cached = { value: members, at: now() };
    return members;
  } catch (error) {
    // Stale forever beats empty: an empty picker is indistinguishable, to the
    // member, from a club with no handles in it. Said out loud so a route that
    // has been broken for a week does not look exactly like one that works.
    log(`[handles] fetch failed, using the last good copy: ${String(error)}`);
    return cached?.value ?? [];
  } finally {
    inFlight = null;
  }
}

/** The handle list, freshest-available. Never rejects. */
export function loadHandles(
  log: (line: string) => void = console.error,
  now: () => number = Date.now
): Promise<ClubHandle[]> {
  if (cached && now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  inFlight ??= refresh(log, now);
  return inFlight;
}

/**
 * The suggestions for what has been typed so far.
 *
 * PURE, so the ranking can be tested without a cache or a network. Prefix hits
 * lead because somebody typing a handle is spelling it from the front; name
 * matches come last because a member searching by name has usually not learned
 * the handle yet and needs the exact-ish matches above them.
 */
export function matchHandles(list: ClubHandle[], query: string): ClubHandle[] {
  // A leading @ is how members write a handle everywhere else, including in the
  // command's own reply, so it must not exclude every result.
  const q = query.trim().replace(/^@/, '').toLowerCase();
  if (!q) return list.slice(0, MAX_CHOICES);

  const prefix: ClubHandle[] = [];
  const inside: ClubHandle[] = [];
  const byName: ClubHandle[] = [];

  for (const entry of list) {
    const handle = entry.handle.toLowerCase();
    if (handle.startsWith(q)) prefix.push(entry);
    else if (handle.includes(q)) inside.push(entry);
    else if (entry.name.toLowerCase().includes(q)) byName.push(entry);
  }

  return [...prefix, ...inside, ...byName].slice(0, MAX_CHOICES);
}

/**
 * Fill the cache at startup, so the first member to open the picker is not the
 * one who pays for the fetch — an autocomplete cannot be deferred, and a cold
 * one has under three seconds to answer.
 */
export function warmHandles(): void {
  void loadHandles().catch((error) => {
    console.error(`[handles] could not warm the cache at startup: ${String(error)}`);
  });
}
