'use client';

import { useCallback, useState } from 'react';
import { BULK_CHUNK, mergeBulkOutcomes, type BulkOutcome } from '@/lib/bulk';
import type { ActionResult } from '@/lib/action-result';

/**
 * Running one bulk action over a whole selection, a chunk at a time.
 *
 * WHY THE BROWSER CHUNKS RATHER THAN THE SERVER LOOPING THE LOT. A bulk action
 * is a loop over the single-record action, which re-authenticates per record and
 * — for an approval — sends an email; a hundred of those in one request is a
 * minute behind a spinner that cannot say how far it has got, sitting on a proxy
 * timeout nobody wants to discover at the term's busiest moment. Ten at a time
 * is a couple of seconds per round trip, and the count below moves while it
 * works.
 *
 * CHUNKS RUN IN SERIES, NOT IN PARALLEL, and it matters for more than politeness
 * to GoTrue: the outcomes are folded in order, so the failures a reader sees are
 * in the order their rows were in.
 *
 * A CHUNK THAT FAILS OUTRIGHT STOPS THE RUN. That is a refused gate, a rejected
 * id list or a dead request — a fact about the whole operation, not about those
 * ten records — and carrying on would fail every remaining chunk the same way
 * while burying the one sentence that explains it. Per-RECORD failures are the
 * opposite and never stop anything: they arrive inside a successful outcome and
 * are reported alongside what did go through.
 */
export interface BulkRunState {
  running: boolean;
  /** Records finished so far, and how many there are. Null when idle. */
  progress: { done: number; total: number } | null;
}

export interface BulkRunResult {
  ok: boolean;
  /** What went through and what did not, folded across every chunk that ran.
   *  Present even when `ok` is false: the chunks BEFORE the failing one really
   *  did happen, and pretending otherwise would leave the officer re-running an
   *  edit that has already been applied. */
  outcome: BulkOutcome;
  /** The whole-operation failure, if there was one. */
  error?: string;
}

export function useBulkRun() {
  const [state, setState] = useState<BulkRunState>({ running: false, progress: null });

  const run = useCallback(
    async (
      ids: string[],
      call: (chunk: string[]) => Promise<ActionResult<BulkOutcome>>,
    ): Promise<BulkRunResult> => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        chunks.push(ids.slice(i, i + BULK_CHUNK));
      }

      setState({ running: true, progress: { done: 0, total: ids.length } });
      const parts: BulkOutcome[] = [];
      try {
        for (const chunk of chunks) {
          const res = await call(chunk);
          if (!res.ok) {
            return { ok: false, outcome: mergeBulkOutcomes(parts), error: res.error };
          }
          parts.push(res.data);
          const done = parts.reduce((n, p) => n + p.attempted, 0);
          setState({ running: true, progress: { done, total: ids.length } });
        }
        return { ok: true, outcome: mergeBulkOutcomes(parts) };
      } catch (err) {
        return {
          ok: false,
          outcome: mergeBulkOutcomes(parts),
          error: err instanceof Error ? err.message : 'Something went wrong',
        };
      } finally {
        setState({ running: false, progress: null });
      }
    },
    [],
  );

  return { ...state, run };
}

/**
 * One sentence saying what happened, for the toast.
 *
 * NEVER "Done": a bulk action whose whole point is that nobody watched it
 * record by record owes the reader a count, and it owes them the failures out
 * loud rather than in a console log. The names come from the caller because the
 * server was never told them — it only ever had ids.
 */
export function describeBulkOutcome(
  outcome: BulkOutcome,
  verb: string,
  nameOf: (id: string) => string,
): { message: string; type: 'success' | 'error' | 'info' } {
  const { succeeded, failures } = outcome;
  if (failures.length === 0) {
    return { message: `${succeeded} ${verb}`, type: 'success' };
  }
  // Two at most, then a count. A toast is one line, and the audit log is where
  // the full story lives.
  const named = failures.slice(0, 2).map((f) => `${nameOf(f.id)} — ${f.error}`).join('; ');
  const rest = failures.length > 2 ? ` (and ${failures.length - 2} more)` : '';
  return {
    message: succeeded > 0
      ? `${succeeded} ${verb}. ${failures.length} could not be: ${named}${rest}`
      : `Nothing was ${verb}. ${named}${rest}`,
    // A run where 38 went through and 2 did not is not a neutral notice — the
    // two are the only part of it anybody has to act on. Any failure at all
    // paints as one.
    type: 'error',
  };
}
