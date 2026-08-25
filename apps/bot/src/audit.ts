// The audit log: an embed in a Discord channel for every piece of work the bot
// does.
//
// Three rules govern this file, and all three are about it staying subordinate
// to the work it records.
//
//  1. IT NEVER FAILS AN ACTION. Every entry point returns void and swallows its
//     own errors. An unlink that succeeded in Discord and then could not be
//     written down is still an unlink, and reporting it as a failure would make
//     the member run the command again against a state that is already correct.
//
//  2. IT IS OPTIONAL. With no DISCORD_AUDIT_CHANNEL_ID the bot runs exactly as
//     it did before, and says so once at startup rather than silently dropping
//     entries — a log nobody configured must not look like a log with nothing
//     in it.
//
//  3. ONE MESSAGE PER OPERATION, NEVER ONE PER MEMBER. Discord's per-channel
//     limit is around 5 messages / 5 seconds; a sweep over a few hundred linked
//     members posting individually would spend most of its wall clock being
//     429ed, and would flood the channel it is supposed to make readable. The
//     sweep therefore posts a single rolled-up entry that NAMES the members it
//     changed.
//
// ---- WHAT GOES IN, AND WHAT DOES NOT ----
//
// Discord user ids only, rendered as mentions. No emails, no player ids, no
// real names: the bot already knows all three, and an audit channel is a
// channel — it inherits whatever permissions somebody set on it, and it is not
// the place to find out those permissions were wrong. A mention is the least
// data that still identifies the row to a human reading it.

import type { DiscordApi } from './discord-api.js';
import type { MemberChange, SweepSummary } from './reconcile.js';
import type { SyncOutcome } from './sync.js';

// Discord caps an embed description at 4096 characters. The cap used here is
// far below that so a long sweep leaves room for the fields and the footer
// without the whole POST being rejected for a 6000-character embed total.
const MAX_LISTED_MEMBERS = 25;

const COLOR_OK = 0x2ecc71;
const COLOR_PARTIAL = 0xf1c40f;
const COLOR_FAILED = 0xe74c3c;
const COLOR_NEUTRAL = 0x95a5a6;

export interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

/** What the bot just did, in the shape the caller already has to hand. */
export type AuditEvent =
  | { kind: 'sweep'; summary: SweepSummary; guilds: number; trigger: 'scheduled' | 'manual' }
  | {
      kind: 'member';
      reason: 'linked' | 'unlinked' | 'resynced';
      discordUserIds: string[];
      summary: SweepSummary;
    };

function mention(discordUserId: string): string {
  return `<@${discordUserId}>`;
}

/** `+2 -1`, or `refused` / `failed` when that is the whole story. */
function describeChange(change: MemberChange): string {
  const parts: string[] = [];
  if (change.added) parts.push(`+${change.added}`);
  if (change.removed) parts.push(`-${change.removed}`);
  if (change.forbidden) parts.push(`${change.forbidden} refused`);
  if (change.failed) parts.push(`${change.failed} failed`);
  return parts.length ? parts.join(' ') : 'no change';
}

/**
 * Green when everything landed, amber when Discord refused something, red when
 * something genuinely broke.
 *
 * Refused is amber and not red ON PURPOSE. A 403 on an exec is the expected
 * answer — the bot cannot modify a member who outranks it — so colouring it red
 * would paint a correct nightly sweep as an incident every single night, and a
 * log that cries wolf nightly is one nobody reads on the night it matters.
 */
function colorFor(summary: { forbidden: number; failed: number }, didWork: boolean): number {
  if (summary.failed) return COLOR_FAILED;
  if (summary.forbidden) return COLOR_PARTIAL;
  return didWork ? COLOR_OK : COLOR_NEUTRAL;
}

/**
 * The changed-member list, truncated with the remainder STATED.
 *
 * A silent cap is the failure mode worth avoiding here: an entry that lists 25
 * members and stops reads as a complete record of 25, which is a worse lie than
 * saying nothing. The counts in the fields are always the true totals.
 */
function memberLines(changes: readonly MemberChange[]): string | undefined {
  if (changes.length === 0) return undefined;
  const shown = changes.slice(0, MAX_LISTED_MEMBERS);
  const lines = shown.map((c) => `${mention(c.discordUserId)} — ${describeChange(c)}`);
  const hidden = changes.length - shown.length;
  if (hidden > 0) lines.push(`…and ${hidden} more (see the sweep response body)`);
  return lines.join('\n');
}

function countFields(summary: SweepSummary): { name: string; value: string; inline: boolean }[] {
  return [
    { name: 'Members swept', value: String(summary.members), inline: true },
    { name: 'Roles added', value: String(summary.added), inline: true },
    { name: 'Roles removed', value: String(summary.removed), inline: true },
    // Only shown when non-zero. A row of permanent zeroes trains the eye to
    // skip the fields, which is exactly where the interesting numbers live.
    ...(summary.forbidden
      ? [{ name: 'Refused (outranks bot)', value: String(summary.forbidden), inline: true }]
      : []),
    ...(summary.failed ? [{ name: 'Failed', value: String(summary.failed), inline: true }] : []),
    ...(summary.absent ? [{ name: 'Not in server', value: String(summary.absent), inline: true }] : []),
  ];
}

const MEMBER_TITLES: Record<'linked' | 'unlinked' | 'resynced', string> = {
  linked: 'Account linked',
  unlinked: 'Account unlinked',
  resynced: 'Roles resynced',
};

/**
 * The embed for an event. Exported separately from the posting so it can be
 * asserted on directly — the interesting logic is what the entry SAYS, and a
 * test for that should not need a fake HTTP client.
 *
 * `now` is injected rather than read from the clock so a test can pin the
 * timestamp.
 */
export function buildAuditEmbed(event: AuditEvent, now: Date): Embed {
  const didWork = event.summary.added > 0 || event.summary.removed > 0;
  const timestamp = now.toISOString();

  if (event.kind === 'sweep') {
    return {
      title:
        event.trigger === 'scheduled' ? 'Nightly role sync' : 'Role sync (manually triggered)',
      description:
        memberLines(event.summary.changes) ??
        'Every linked member already had the right roles. Nothing to change.',
      color: colorFor(event.summary, didWork),
      fields: countFields(event.summary),
      footer: {
        text: `${event.guilds} server${event.guilds === 1 ? '' : 's'} · ${event.summary.cleared.length} tombstone${event.summary.cleared.length === 1 ? '' : 's'} cleared`,
      },
      timestamp,
    };
  }

  // A member event names the members it was ASKED about, not only the ones that
  // changed. "Roles resynced, nothing to do" is a fact worth recording: it is
  // the difference between the bot deciding no change was needed and the bot
  // never having been called at all.
  const asked = event.discordUserIds.map(mention).join(', ');
  const changed = memberLines(event.summary.changes);
  return {
    title: MEMBER_TITLES[event.reason],
    description: changed ? `${asked}\n\n${changed}` : `${asked}\n\nNo role changes were needed.`,
    color: colorFor(event.summary, didWork),
    fields: countFields(event.summary).filter((f) => f.name !== 'Members swept'),
    timestamp,
  };
}

/**
 * Write one entry. Returns whether it was written, which every caller is free
 * to ignore — see rule 1 at the top of this file.
 */
export async function postAuditEntry(
  api: DiscordApi,
  channelId: string | undefined,
  event: AuditEvent,
  now: Date = new Date(),
  log: (line: string) => void = console.error
): Promise<boolean> {
  if (!channelId) return false;
  try {
    const ok = await api.createMessage(channelId, { embeds: [buildAuditEmbed(event, now)] });
    if (!ok) {
      // Worth a line: the usual cause is the bot lacking View Channel or Send
      // Messages on the audit channel, which is invisible from inside Discord
      // because the bot simply says nothing.
      log('[audit] Discord refused the audit entry — check the bot can post in that channel');
    }
    return ok;
  } catch (error) {
    log(`[audit] could not write audit entry: ${String(error)}`);
    return false;
  }
}

/**
 * A member event's summary, rolled up from the outcomes a single sync already
 * produced. Lets /unlink reuse the sweep-shaped embed without pretending it ran
 * a sweep.
 */
export function summaryFromOutcomes(
  discordUserId: string,
  outcomes: readonly SyncOutcome[]
): SweepSummary {
  const summary: SweepSummary = {
    cleared: [],
    changes: [],
    members: 1,
    added: 0,
    removed: 0,
    forbidden: 0,
    failed: 0,
    absent: 0,
  };
  for (const o of outcomes) {
    summary.added += o.added;
    summary.removed += o.removed;
    summary.forbidden += o.forbidden;
    summary.failed += o.failed;
    summary.absent += o.absent ? 1 : 0;
  }
  if (summary.added || summary.removed || summary.forbidden || summary.failed) {
    summary.changes.push({
      discordUserId,
      added: summary.added,
      removed: summary.removed,
      forbidden: summary.forbidden,
      failed: summary.failed,
    });
  }
  return summary;
}
