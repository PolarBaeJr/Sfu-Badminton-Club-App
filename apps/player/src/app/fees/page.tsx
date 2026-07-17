import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { unwrap, unwrapMaybe } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { PageHeader } from '@badminton/ui';

// The player supabase client is untyped, so column-list selects resolve to
// `never` — annotate the unwrap helpers with the row shape we expect.
type TermRow = { id: string; label: string; default_fee_cents: number };
type ClubFeeRow = { amount_cents: number | null; paid_at: string | null };
type EventRefRow = { event: { tournament_id: string } | { tournament_id: string }[] | null };
type TournamentRow = { id: string; name: string };
type TournamentFeeRow = {
  tournament_id: string;
  amount_cents: number | null;
  paid_at: string | null;
  tier_id: string | null;
};
type FeeTierRow = { id: string; tournament_id: string; amount_cents: number; is_default: boolean };

function money(cents: number | null | undefined): string {
  return cents == null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

function StatusPill({ paid }: { paid: boolean }) {
  return (
    <span
      className="pill"
      style={{
        color: paid ? 'var(--win)' : 'var(--loss)',
        fontWeight: 600,
      }}
    >
      {paid ? 'Paid' : 'Outstanding'}
    </span>
  );
}

export default async function FeesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const exempt = player.is_exec || player.fee_exempt;

  // Club dues — active term + this player's paid row for it.
  const termRes = exempt
    ? null
    : await supabase.from('terms').select('id, label, default_fee_cents').eq('active', true).maybeSingle();
  const term = termRes ? unwrapMaybe<TermRow>(termRes) : null;
  const clubFeeRes = term
    ? await supabase
        .from('club_fees')
        .select('amount_cents, paid_at')
        .eq('player_id', player.id)
        .eq('term_id', term.id)
        .maybeSingle()
    : null;
  const clubFee = clubFeeRes ? unwrapMaybe<ClubFeeRow>(clubFeeRes) : null;
  const clubPaid = clubFee?.paid_at != null;
  const clubOwedCents = clubPaid ? clubFee?.amount_cents ?? null : term?.default_fee_cents ?? null;

  // Competition dues — tournaments the player is entered in (singles + doubles).
  const competitionRows: { id: string; name: string; owedCents: number | null; paid: boolean }[] = [];
  if (!exempt) {
    const [partRes, pairRes] = await Promise.all([
      supabase
        .from('tournament_participants')
        .select('event:tournament_events(tournament_id)')
        .eq('player_id', player.id)
        .neq('status', 'withdrawn'),
      supabase
        .from('tournament_pairs')
        .select('event:tournament_events(tournament_id)')
        .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
        .neq('status', 'withdrawn'),
    ]);

    const extractIds = (rows: EventRefRow[] | null): string[] =>
      (rows ?? [])
        .map((r) => {
          const event = Array.isArray(r.event) ? r.event[0] : r.event;
          return event?.tournament_id ?? null;
        })
        .filter((id): id is string => id != null);

    const tournamentIds = Array.from(
      new Set([...extractIds(unwrapMaybe<EventRefRow[]>(partRes)), ...extractIds(unwrapMaybe<EventRefRow[]>(pairRes))]),
    );

    if (tournamentIds.length > 0) {
      const [tournamentsRes, feesRes, tiersRes] = await Promise.all([
        supabase.from('tournaments').select('id, name').in('id', tournamentIds),
        supabase
          .from('tournament_fees')
          .select('tournament_id, amount_cents, paid_at, tier_id')
          .eq('player_id', player.id)
          .in('tournament_id', tournamentIds),
        supabase
          .from('tournament_fee_tiers')
          .select('id, tournament_id, amount_cents, is_default')
          .in('tournament_id', tournamentIds),
      ]);
      const tournaments = unwrap<TournamentRow[]>(tournamentsRes);
      const fees = unwrapMaybe<TournamentFeeRow[]>(feesRes);
      const tiers = unwrapMaybe<FeeTierRow[]>(tiersRes);

      const feeByTournament = new Map((fees ?? []).map((f) => [f.tournament_id, f]));
      const tierById = new Map((tiers ?? []).map((t) => [t.id, t]));
      const defaultTierByTournament = new Map(
        (tiers ?? []).filter((t) => t.is_default).map((t) => [t.tournament_id, t]),
      );

      for (const t of tournaments) {
        const fee = feeByTournament.get(t.id);
        let owedCents: number | null;
        if (fee?.amount_cents != null) {
          owedCents = fee.amount_cents;
        } else if (fee?.tier_id != null) {
          owedCents = tierById.get(fee.tier_id)?.amount_cents ?? null;
        } else {
          owedCents = defaultTierByTournament.get(t.id)?.amount_cents ?? null;
        }
        competitionRows.push({
          id: t.id,
          name: t.name,
          owedCents,
          paid: fee?.paid_at != null,
        });
      }
      competitionRows.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  return (
    <div data-screen-label="Fees" style={{ maxWidth: 720, margin: '0 auto' }}>
      <PageHeader
        eyebrow="ACCOUNT · DUES"
        title="Fees & dues"
        sub="What you owe for club membership and tournament entry. Payments are recorded by an admin."
      />

      {player.is_banned && (
        <div
          className="card-base"
          style={{ borderColor: 'var(--loss)', background: 'var(--red-wash)', marginBottom: 24 }}
        >
          <div style={{ fontWeight: 600, color: 'var(--loss)', marginBottom: 4 }}>
            Account suspended
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Your account is suspended pending a reinstatement fee — contact an admin to be reinstated.
          </div>
        </div>
      )}

      <div className="feed-col">
        {exempt ? (
          <div className="card-base">
            <div className="card-head">
              <h3 className="card-title">Club & competition dues</h3>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              You&apos;re exempt from club and competition fees.
            </p>
          </div>
        ) : (
          <>
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Club dues</h3>
              </div>
              {term ? (
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{term.label}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>{money(clubOwedCents)}</div>
                  </div>
                  <StatusPill paid={clubPaid} />
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>No active term — nothing due.</p>
              )}
            </div>

            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Competition dues</h3>
                {competitionRows.length > 0 && <span className="tag">{competitionRows.length}</span>}
              </div>
              {competitionRows.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  You&apos;re not entered in any tournaments — nothing due.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {competitionRows.map((row) => (
                    <div
                      key={row.id}
                      className="row"
                      style={{
                        justifyContent: 'space-between',
                        padding: '12px 14px',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        gap: 12,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{row.name}</div>
                        <div className="mono muted" style={{ fontSize: 11 }}>{money(row.owedCents)}</div>
                      </div>
                      <StatusPill paid={row.paid} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
