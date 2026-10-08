/**
 * The player columns the Edit dialog READS.
 *
 * <PlayerActions> is rendered from two pages — the roster (/players) and the
 * dashboard's pending-approval queue — and each one wrote its own `.select()`.
 * `playerData` was typed `Record<string, unknown>`, so a page that forgot a
 * column handed the dialog `undefined` and the control silently seeded a
 * plausible DEFAULT instead of failing: `membership_type` opened on "Internal"
 * for an alumnus, and saving would have written that wrong value back.
 *
 * This type is the contract instead. `playerData` is declared as PlayerEditRow,
 * and the roster's row type is INFERRED from its select string, so dropping a
 * column from the query is a compile error at the call site rather than a wrong
 * default at runtime.
 *
 * ADDING A CONTROL TO THE DIALOG? Add its column here first, then follow the
 * type errors — they are the complete list of queries that have to fetch it.
 */
export type PlayerEditRow = {
  id: string;
  // Seeds the Status select. `active_flag === false` presents as "Inactive"
  // whatever `status` holds, which is why both are needed and not just one.
  status: string | null;
  active_flag: boolean | null;
  fee_exempt: boolean | null;
  membership_type: string | null;
};

/**
 * The same columns as a select fragment, for a query that has no other reason
 * to name them. The roster and the dashboard both fetch a superset for their
 * own rendering, so they spell theirs out; this exists so a THIRD call site
 * does not have to rediscover the list.
 */
export const PLAYER_EDIT_COLUMNS = 'id, status, active_flag, fee_exempt, membership_type';
