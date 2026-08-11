// WHO MAY ACTUALLY PLAY — the event-waiver eligibility rules, as pure functions.
//
// A tournament may carry its own waiver (tournaments.waiver_text, 00015).
// A member who enters themselves cannot get past registerForEvent without
// accepting it. A member an EXEC adds — addParticipantToEvent,
// addParticipantsToEvent, addPairToEvent — was never asked, and until now
// nothing anywhere noticed.
//
// The club owner's rule is PERMISSIVE AT ENTRY, STRICT AT PARTICIPATION: adding
// somebody keeps working, because the walk-up on the day is real and an exec
// must be able to get them onto the sheet. What changes is that being on the
// sheet stops being enough — check-in refuses an entrant with no acceptance of
// the CURRENT wording.
//
// ---------------------------------------------------------------------------
// NO node:crypto IN THIS FILE, AND IT IS IN THE BARREL BECAUSE OF THAT
// ---------------------------------------------------------------------------
// eventWaiverHash() lives in ./event-waiver and uses node:crypto; its own
// comment says it must be imported by subpath, never through the barrel, or the
// player app drags a Node builtin into the browser bundle. Every function here
// therefore takes the required hash as a STRING PARAMETER and computes nothing.
// Hashing is the caller's job, on the server, from the server's own copy of the
// text — the same discipline registerForEvent already follows, where the hash is
// never taken from anything the client sent.
//
// ---------------------------------------------------------------------------
// WHY A STALE SIGNATURE IS NOT A SIGNATURE
// ---------------------------------------------------------------------------
// An acceptance is pinned to a SHA-256 of the exact text the member read
// (00015). Edit tournaments.waiver_text and every existing hash stops matching,
// so everyone who signed is unsigned again. That is not a bug to work around —
// it is the only defensible reading of a signed document, and it is why
// `stale` exists as a state distinct from `unsigned`: the member DID sign
// something, just not this. The two block identically and read differently, so
// the exec at the door can tell "never asked" from "the wording moved under
// them", which are different conversations.

/** What we know about one member's standing against one tournament's waiver. */
export type EventWaiverState =
  /** The tournament has no waiver text. Nothing to sign, nothing to block. */
  | 'not_required'
  /** An acceptance exists for the wording that is live right now. */
  | 'signed'
  /** They accepted an EARLIER wording. The text has been edited since. */
  | 'stale'
  /** No acceptance of any wording, ever. */
  | 'unsigned';

// The minimal shape these rules read off an `event_waiver_acceptances` row.
// NOT named `EventWaiverAcceptance` — that name is already the full row type in
// ./types/database, and this is deliberately narrower so a caller can pass a
// projected select (three columns, not six) without a cast. The real row is
// structurally compatible, so passing one works.
export interface AcceptedEventWaiver {
  player_id: string;
  waiver_hash: string;
  accepted_at: string;
}

export interface EventWaiverStatus {
  state: EventWaiverState;
  /** May this member take part? True for `not_required` and `signed` only. */
  eligible: boolean;
  /** When they accepted the CURRENT wording, if they did. */
  signedAt: string | null;
  /** When they last accepted ANY wording — the date shown for a stale signer. */
  lastAcceptedAt: string | null;
  /** The hash they last accepted, whatever it was. Shown as a short version. */
  lastAcceptedHash: string | null;
}

const NOT_REQUIRED: EventWaiverStatus = {
  state: 'not_required',
  eligible: true,
  signedAt: null,
  lastAcceptedAt: null,
  lastAcceptedHash: null,
};

/**
 * The text that applies to a tournament, or null if it has none.
 *
 * THE ONE RESOLUTION RULE, and it is the player app's, transcribed rather than
 * invented: registerForEvent reads `tournament.waiver_text?.trim()` and treats
 * a falsy result as "no waiver". Per-season templates (event_waiver_templates,
 * 00074) are NOT consulted here and must never be — a template is copied into
 * waiver_text when the event is created and never referenced again, precisely so
 * that editing the template cannot retroactively change what somebody already
 * agreed to. A second resolution rule that fell back to the template would undo
 * that on the read side.
 *
 * The trim also means a box holding only whitespace is no waiver at all, which
 * is what an exec who cleared it meant.
 */
export function resolveEventWaiverText(
  tournament: { waiver_text?: string | null } | null | undefined,
): string | null {
  const text = tournament?.waiver_text?.trim();
  return text ? text : null;
}

/** Does this tournament require an event waiver at all? */
export function eventWaiverRequired(
  tournament: { waiver_text?: string | null } | null | undefined,
): boolean {
  return resolveEventWaiverText(tournament) !== null;
}

/**
 * Where one member stands.
 *
 * `requiredHash` is null when the tournament has no waiver — pass
 * `eventWaiverHash(resolveEventWaiverText(t))` when it does, computed on the
 * server from the server's copy of the text.
 *
 * `acceptances` may be every row for the tournament; rows for other members are
 * ignored, so a caller that fetched the whole draw in one query does not have to
 * bucket them first.
 */
export function eventWaiverStatus(
  playerId: string,
  requiredHash: string | null,
  acceptances: readonly AcceptedEventWaiver[],
): EventWaiverStatus {
  if (!requiredHash) return NOT_REQUIRED;

  let signedAt: string | null = null;
  let lastAcceptedAt: string | null = null;
  let lastAcceptedHash: string | null = null;

  for (const row of acceptances) {
    if (row.player_id !== playerId) continue;
    // Latest wins for the display date. The unique index is on
    // (player_id, tournament_id, waiver_hash), so re-accepting the SAME wording
    // does not add a row — several rows here means the text was edited and they
    // signed more than one version of it.
    if (lastAcceptedAt === null || row.accepted_at > lastAcceptedAt) {
      lastAcceptedAt = row.accepted_at;
      lastAcceptedHash = row.waiver_hash;
    }
    if (row.waiver_hash === requiredHash) {
      if (signedAt === null || row.accepted_at > signedAt) signedAt = row.accepted_at;
    }
  }

  if (signedAt !== null) {
    return { state: 'signed', eligible: true, signedAt, lastAcceptedAt, lastAcceptedHash };
  }
  if (lastAcceptedAt !== null) {
    return { state: 'stale', eligible: false, signedAt: null, lastAcceptedAt, lastAcceptedHash };
  }
  return { state: 'unsigned', eligible: false, signedAt: null, lastAcceptedAt: null, lastAcceptedHash: null };
}

/**
 * The short version string an exec sees, standing in for the `v3` that
 * legal_documents carries. An event waiver has no version number — the hash IS
 * its identity — so the first seven characters are shown the way a git short
 * SHA is, enough to tell two wordings apart at a glance and useless as anything
 * else.
 */
export function eventWaiverShortVersion(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return hash.slice(0, 7);
}

/**
 * The one-line state, in the shape /legal uses for the four club documents:
 * `signed v3 · 02 AUG 2026` / `never signed`.
 *
 * `shortDate` is injected rather than imported so this stays pure and
 * locale-free — the caller passes whatever formatter its page already uses,
 * which is how the admin roster ends up reading identically to /legal.
 */
export function eventWaiverStateLabel(
  status: EventWaiverStatus,
  shortDate: (iso: string) => string,
): string {
  switch (status.state) {
    case 'not_required':
      return 'no event waiver';
    case 'signed':
      return `signed v${eventWaiverShortVersion(status.lastAcceptedHash) ?? '???????'} · ${shortDate(status.signedAt!)}`;
    // Deliberately says the WORDING moved, not that they failed to do
    // something. They signed; the club changed the text underneath them.
    case 'stale':
      return `signed v${eventWaiverShortVersion(status.lastAcceptedHash) ?? '???????'} · ${shortDate(status.lastAcceptedAt!)} — wording has changed since`;
    case 'unsigned':
      return 'never signed';
  }
}

// ---------------------------------------------------------------------------
// SCREENING A WHOLE FIELD
// ---------------------------------------------------------------------------
// Check-in happens one entrant at a time at a desk, but also in bulk (the
// "Check In All Present" button) and in bulk-per-member (one QR scan checks a
// player into every event they are in). The bulk paths must NOT fail whole
// because one entrant is unsigned — a queue held up by an all-or-nothing
// refusal is exactly the failure this feature is supposed to prevent. So they
// partition instead: check in everyone who may play, and report by name who was
// left out and why.

/** One thing that can be checked in: a singles entrant, or a pair. */
export interface EventWaiverEntry {
  /** The tournament_participants / tournament_pairs row id. */
  id: string;
  /**
   * Every member whose signature this entry needs. A pair needs BOTH — an
   * entry with one signature is not half-eligible, it is a team that cannot
   * take the court.
   */
  members: readonly { id: string; name: string }[];
}

export interface BlockedEntry {
  id: string;
  /** The members holding it up, with the state each is in. */
  unsigned: { id: string; name: string; state: EventWaiverState }[];
}

export interface EventWaiverScreening {
  /** Entry ids clear to be checked in. */
  allowed: string[];
  blocked: BlockedEntry[];
}

/**
 * Split a field into who may be checked in and who may not.
 *
 * A pair appears in `blocked` if EITHER half is unsigned, and its `unsigned`
 * list names only the half or halves at fault — the signed partner is not
 * accused of anything, and the exec is told exactly whose phone to point at.
 */
export function screenForEventWaiver(
  entries: readonly EventWaiverEntry[],
  requiredHash: string | null,
  acceptances: readonly AcceptedEventWaiver[],
): EventWaiverScreening {
  if (!requiredHash) return { allowed: entries.map((e) => e.id), blocked: [] };

  const allowed: string[] = [];
  const blocked: BlockedEntry[] = [];

  for (const entry of entries) {
    const unsigned: BlockedEntry['unsigned'] = [];
    for (const member of entry.members) {
      const status = eventWaiverStatus(member.id, requiredHash, acceptances);
      if (!status.eligible) unsigned.push({ id: member.id, name: member.name, state: status.state });
    }
    if (unsigned.length === 0) allowed.push(entry.id);
    else blocked.push({ id: entry.id, unsigned });
  }

  return { allowed, blocked };
}

/**
 * What the officer at the door is told.
 *
 * A blocked check-in with no explanation, at a queue, is worse than the gap
 * this closes — the exec cannot fix it, cannot explain it, and will look for a
 * way round it. So the message names the people, distinguishes "never asked"
 * from "the text changed", and says the one thing that actually resolves it:
 * the member signs, on their own account, from the tournament page.
 *
 * It deliberately does NOT offer the exec a way to record the signature
 * themselves, because there isn't one and there must not be.
 */
export function eventWaiverRefusal(blocked: readonly BlockedEntry[]): string {
  const everyone = blocked.flatMap((entry) => entry.unsigned);
  if (everyone.length === 0) return '';

  // Dedupe: one member can hold up several entries in the same tournament.
  const seen = new Map<string, { name: string; state: EventWaiverState }>();
  for (const member of everyone) {
    if (!seen.has(member.id)) seen.set(member.id, { name: member.name, state: member.state });
  }
  const members = [...seen.values()];

  const names = members.map((m) => m.name).join(', ');
  const anyStale = members.some((m) => m.state === 'stale');

  const who = members.length === 1
    ? `${names} has not accepted this tournament's event waiver`
    : `${names} have not accepted this tournament's event waiver`;

  const because = anyStale
    ? ' (the waiver text has been edited since they last signed, so their acceptance no longer covers it)'
    : '';

  return (
    `${who}${because}. They cannot be checked in until they do. ` +
    'Ask them to open the club app, go to this tournament and accept it there — ' +
    'it takes a few seconds, and it has to be them, signed in as themselves. ' +
    'Nobody can accept it on their behalf.'
  );
}
