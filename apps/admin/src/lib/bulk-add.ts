/**
 * Doing one server action N times, and telling the truth about it afterwards.
 *
 * The three "add these people" dialogs became multi-select, but the server
 * actions behind them took exactly ONE id. Rather than widen three actions — and
 * with them three sets of validation, audit rows and revalidatePath calls — the
 * client loops. That choice is only defensible if the loop reports honestly,
 * which is what summarizeBulk is for: twelve people chosen and nine added is
 * "Added 9 of 12", never a green "Added".
 *
 * It stops being defensible at scale. Seeding a 128-slot draw meant sixty round
 * trips, each re-rendering the event page through revalidatePath, and it read as
 * a hang. The EVENT participant dialog now calls addParticipantsToEvent, which
 * takes the whole array and returns the same succeeded/failures shape, so it
 * still summarises through here. The remaining callers (tournament-level
 * participants, session walk-ins) add a handful of people at a time and still
 * loop; widen them the same way if that ever changes.
 *
 * No React and no server imports, so the summary wording is unit-testable.
 */

export interface BulkFailure {
  id: string;
  message: string;
}

export interface BulkOutcome {
  /** Ids the action accepted, in the order they were attempted. */
  succeeded: string[];
  failures: BulkFailure[];
}

/**
 * Run `run` over the ids ONE AT A TIME, collecting rather than propagating
 * failures.
 *
 * Sequential on purpose, for the callers that still use it. The add actions
 * count the current field against `max_participants` before inserting; twelve of
 * those in flight at once would all read the same pre-insert count and every one
 * would sail past a full event. Sequential also keeps the audit log in the order
 * the exec picked. (The batched addParticipantsToEvent keeps both properties a
 * different way: it counts once and trims the overflow itself.)
 *
 * `run` must THROW to signal failure. Actions that report through an
 * ActionResult instead (markAttendance) have to be adapted by the caller —
 * a rejected `{ ok: false }` returned quietly would be counted as a success.
 */
export async function runBulk(
  ids: string[],
  run: (id: string) => Promise<unknown>,
): Promise<BulkOutcome> {
  const succeeded: string[] = [];
  const failures: BulkFailure[] = [];
  for (const id of ids) {
    try {
      await run(id);
      succeeded.push(id);
    } catch (err) {
      failures.push({ id, message: err instanceof Error ? err.message : 'Failed' });
    }
  }
  return { succeeded, failures };
}

export interface BulkLabels {
  /** Past tense, for the happy path: "Added", "Marked". */
  done: string;
  /** "Could not add", "Could not mark". */
  failed: string;
  /** Singular unit: "participant", "player present". */
  noun: string;
  /** Plural unit; defaults to `noun` + "s". */
  nounPlural?: string;
}

export type BulkTone = 'success' | 'error' | 'info';

/**
 * One toast for the whole batch, worded so a partial failure cannot be mistaken
 * for a success.
 *
 * The distinct reasons are collapsed: adding eight people to a full event
 * produces eight identical "Event is full" errors, and eight lines of the same
 * sentence tells the exec nothing that one line does not.
 */
export function summarizeBulk(
  outcome: BulkOutcome,
  labels: BulkLabels,
): { message: string; tone: BulkTone } {
  const { succeeded, failures } = outcome;
  const total = succeeded.length + failures.length;
  const plural = labels.nounPlural ?? `${labels.noun}s`;
  const unit = (n: number) => (n === 1 ? labels.noun : plural);

  if (total === 0) return { message: 'Nobody selected', tone: 'info' };

  if (failures.length === 0) {
    return { message: `${labels.done} ${total} ${unit(total)}`, tone: 'success' };
  }

  const distinct = [...new Set(failures.map((f) => f.message))];
  const reason =
    distinct.length === 1
      ? distinct[0]
      : `${distinct[0]} (+${distinct.length - 1} other error${distinct.length === 2 ? '' : 's'})`;

  if (succeeded.length === 0) {
    return { message: `${labels.failed} ${total} ${unit(total)} — ${reason}`, tone: 'error' };
  }

  // The whole point of the helper. "9 of 12" states the shortfall in the same
  // breath as the success, and the tone is error so it does not read as done.
  return {
    message: `${labels.done} ${succeeded.length} of ${total} ${plural} — ${reason}`,
    tone: 'error',
  };
}
