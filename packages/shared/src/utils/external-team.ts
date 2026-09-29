// An external team (00269): two people with no member account, entered by the
// organisers by name only. The same rule add_external_tournament_pair applies,
// run first so the desk gets a readable refusal without a round trip. The
// database stays authoritative.

export const EXTERNAL_NAME_MAX = 60;

export type ExternalTeamNames =
  | { ok: true; names: [string, string]; teamName: string | null }
  | { ok: false; error: string };

function tidy(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.replace(/\s+/g, ' ').trim();
}

// The team name is optional: absent or blank means none, and the pair is then
// named "A / B".
export function normalizeExternalTeamNames(a: unknown, b: unknown, teamName?: unknown): ExternalTeamNames {
  const first = tidy(a);
  const second = tidy(b);
  if (first === null || second === null) return { ok: false, error: 'Both players need a name.' };
  for (const name of [first, second]) {
    if (name.length < 1 || name.length > EXTERNAL_NAME_MAX) {
      return { ok: false, error: `Each player needs a name of 1 to ${EXTERNAL_NAME_MAX} characters.` };
    }
  }
  if (first.toLowerCase() === second.toLowerCase()) {
    return { ok: false, error: 'The two players need different names.' };
  }
  let team: string | null = null;
  if (teamName !== undefined && teamName !== null) {
    const tidied = tidy(teamName);
    if (tidied === null) return { ok: false, error: 'The team name must be text.' };
    if (tidied.length > EXTERNAL_NAME_MAX) {
      return { ok: false, error: `A team name can be at most ${EXTERNAL_NAME_MAX} characters.` };
    }
    team = tidied.length > 0 ? tidied : null;
  }
  return { ok: true, names: [first, second], teamName: team };
}
