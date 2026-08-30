import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getMissingLegalDocuments, type WaiverDocument } from '@badminton/shared';

export type LegalAcceptance = { document: string; version: string; accepted_at: string };

// One source of truth for "does this member owe us a signature".
//
// The layout and the gameplay server actions used to answer this question with
// two separate reads and two different failure behaviours, so a database or RLS
// fault could block every mutation while the UI showed no gate at all — the
// member had no way to see why, let alone fix it. Both callers go through here
// now, and both inherit the same verdict, including 'unavailable'.
export type LegalGateResult =
  | { status: 'ok'; missing: WaiverDocument[] }
  | { status: 'unavailable' };

export async function evaluateLegalGate(
  supabase: SupabaseClient,
  player: { waiver_reset_at?: string | null; waiver_acceptances?: LegalAcceptance[] | null },
  now: Date = new Date(),
): Promise<LegalGateResult> {
  const { data: docs, error } = await supabase
    .from('legal_documents')
    .select('document, version, reacceptance_required_since');
  // A failed read arrives as `docs == null`, which without this check is
  // indistinguishable from a club that has published nothing to accept.
  if (error) {
    Sentry.captureException(error, { tags: { gate: 'legal_documents' } });
    return { status: 'unavailable' };
  }
  // An empty table, read successfully, is a real state and not a fault.
  if (!docs || docs.length === 0) return { status: 'ok', missing: [] };
  return {
    status: 'ok',
    missing: getMissingLegalDocuments(docs, player.waiver_acceptances ?? [], now, player.waiver_reset_at),
  };
}
