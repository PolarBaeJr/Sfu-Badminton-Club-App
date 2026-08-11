import { describe, it, expect, beforeEach, vi } from 'vitest';

// DELETING A POST HAS TO TAKE ITS BELL ROWS WITH IT.
//
// Two tables point at an announcement and only one of them is wired to the
// schema. `announcement_reads.announcement_id` is a real FK, ON DELETE CASCADE
// (00001_schema.sql:616), so Postgres clears the receipts on its own.
// `notifications` has no FK at all — the only link is `metadata.announcement_id`
// written by dispatchAnnouncementNotifications — so nothing cleaned those up and
// a deleted post left one row per member behind it, headlined with the first 140
// characters of the post the club had just retracted.
//
// The fake below models BOTH of those facts: it cascades announcement_reads and
// it does not cascade notifications. A fake that cascaded everything would let
// the bug pass, and a fake that cascaded nothing would make the removed
// announcement_reads sweep look necessary.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Every table the action asked for, in order, so a round trip can be counted. */
  touched: [] as string[],
  actor: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } as Row,
}));

const makeClient = vi.hoisted(() => () => {
  /**
   * Reads `metadata->>announcement_id` off a row the way PostgREST does — the
   * filter this action relies on, verified against staging before it was used
   * (`metadata->>event_id=eq.<uuid>` returns exactly the rows the equivalent SQL
   * counts). A plain column name takes the plain path.
   */
  function valueAt(row: Row, column: string): unknown {
    const json = column.split('->>');
    if (json.length === 1) return row[column];
    const container = row[json[0]!] as Row | null | undefined;
    return container?.[json[1]!];
  }

  function query(table: string) {
    store.touched.push(table);
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'delete' = 'select';

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => valueAt(r, c) === v));

    const run = (): { data: Row[] | null; error: null; count: number } => {
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        // The FK. Only announcements cascades, and only onto the receipts.
        if (table === 'announcements') {
          const gone = new Set(hit.map((r) => r.id));
          store.db.announcement_reads = (store.db.announcement_reads ?? []).filter(
            (r) => !gone.has(r.announcement_id),
          );
        }
        return { data: hit, error: null, count: hit.length };
      }
      const hit = matching();
      return { data: hit, error: null, count: hit.length };
    };

    const api = {
      select() { return api; },
      delete(_opts?: { count?: string }) { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ requireCapability: async () => store.actor }));
vi.mock('../audit', () => ({ logAdminAudit: async () => {} }));
vi.mock('../notify', () => ({ notifyPlayers: async () => {} }));

import { deleteAnnouncement } from '../actions/announcements';

const GOING = '5eed0010-0000-4000-8000-000000000001';
const STAYING = '5eed0010-0000-4000-8000-000000000002';
const REASON = 'Posted to the wrong audience';

const notifications = () => store.db.notifications ?? [];
const reads = () => store.db.announcement_reads ?? [];

beforeEach(() => {
  store.touched = [];
  store.db = {
    announcements: [
      { id: GOING, title: 'West Gym is closed', status: 'published' },
      { id: STAYING, title: 'Fall season is open', status: 'published' },
    ],
    announcement_reads: [
      { id: 'r1', announcement_id: GOING, player_id: 'p1' },
      { id: 'r2', announcement_id: GOING, player_id: 'p2' },
      { id: 'r3', announcement_id: STAYING, player_id: 'p1' },
    ],
    notifications: [
      { id: 'n1', type: 'general', player_id: 'p1', metadata: { announcement_id: GOING, kind: 'announcement' } },
      { id: 'n2', type: 'general', player_id: 'p2', metadata: { announcement_id: GOING, kind: 'announcement' } },
      { id: 'n3', type: 'general', player_id: 'p1', metadata: { announcement_id: STAYING, kind: 'announcement' } },
      // A row of the same carrier type from a different producer. `general` is
      // shared by announcements, tournament registration and challenge
      // reminders, so the filter has to be the metadata key and not the type.
      { id: 'n4', type: 'general', player_id: 'p1', metadata: { challenge_id: 'c1' } },
      { id: 'n5', type: 'session_reminder', player_id: 'p1', metadata: { session_id: 's1' } },
    ],
    audit_logs: [],
  };
});

describe('deleteAnnouncement — what the post takes with it', () => {
  it('removes the notifications that pointed at the deleted post', async () => {
    await deleteAnnouncement(GOING, REASON);

    expect(notifications().map((n) => n.id)).toEqual(['n3', 'n4', 'n5']);
  });

  it('leaves every other member notification alone', async () => {
    await deleteAnnouncement(GOING, REASON);

    // Another post's bell rows, another producer's `general` row, and an
    // unrelated type. None of them is keyed to the post that went.
    expect(notifications().find((n) => n.id === 'n3')).toBeDefined();
    expect(notifications().find((n) => n.id === 'n4')).toBeDefined();
    expect(notifications().find((n) => n.id === 'n5')).toBeDefined();
  });

  it('lets the FK clear the read receipts instead of spending a round trip on them', async () => {
    await deleteAnnouncement(GOING, REASON);

    // Gone — but by the cascade, which is why the fake models it.
    expect(reads().map((r) => r.id)).toEqual(['r3']);
    // And the action never opened the table itself. This is the assertion that
    // the redundant sweep stays removed.
    expect(store.touched).not.toContain('announcement_reads');
  });

  it('touches notifications before it deletes the post', async () => {
    await deleteAnnouncement(GOING, REASON);

    // Order matters: a failure clearing the bell rows must leave the post — and
    // the audit log — untouched, so the admin can simply try again.
    expect(store.touched.indexOf('notifications')).toBeLessThan(
      store.touched.lastIndexOf('announcements'),
    );
  });

  it('deletes nothing when the reason is missing', async () => {
    await expect(deleteAnnouncement(GOING, '   ')).rejects.toThrow(/reason/i);

    expect(notifications()).toHaveLength(5);
    expect(store.db.announcements).toHaveLength(2);
  });

  it('still reports a post somebody else already deleted', async () => {
    store.db.announcements = [{ id: STAYING, title: 'Fall season is open', status: 'published' }];

    await expect(deleteAnnouncement(GOING, REASON)).rejects.toThrow(/no longer exists/i);
  });
});
