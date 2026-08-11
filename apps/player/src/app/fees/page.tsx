import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { unwrap, unwrapMaybe } from '@badminton/shared';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Atomic, Badge } from '@badminton/ui';
import {
  headlineAmount,
  headlineBadge,
  money,
  outstandingFooter,
  receiptMeta,
  seasonDateline,
  settlementOf,
  summariseFees,
  type FeeLine,
} from '@/lib/fees';

// The player supabase client is untyped, so column-list selects resolve to
// `never` — annotate the unwrap helpers with the row shape we expect.
type SeasonRow = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
};
type ClubFeeRow = {
  id: string;
  amount_cents: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
};
type EventRefRow = { event: { tournament_id: string } | { tournament_id: string }[] | null };
type TournamentRow = { id: string; name: string };
type TournamentFeeRow = {
  id: string;
  tournament_id: string;
  amount_cents: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  tier_id: string | null;
};
type FeeTierRow = { id: string; tournament_id: string; amount_cents: number; is_default: boolean };
type ReinstatementRow = {
  id: string;
  amount_cents: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
};

export default async function FeesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const exempt = player.is_exec || player.fee_exempt;

  // ── Reading only THIS member's money ──────────────────────────────────
  // Every query below runs on the session client (anon key + the member's JWT),
  // never the service-role client getCurrentPlayer() uses for the player's own
  // row. That means two independent layers say "yours only":
  //
  //   1. an explicit .eq('player_id', player.id) on all three fee ledgers, and
  //   2. RLS — club_fees_select_own / tf_select_own / rf_select_own in
  //      00005_rls.sql, each USING (player_id = get_player_id(auth.uid())).
  //
  // Either alone would do it; both together mean a dropped filter cannot become
  // a leak of somebody else's payment history. The one table read without a
  // player filter is `seasons`, which is club-wide public price-list data:
  // seasons_select is USING (TRUE) and get_active_season() is granted to anon,
  // so both fee tiers are already world-readable and printing them here is not
  // a new disclosure.

  // The active season. Read directly rather than through getActiveSeason(),
  // because get_active_season() returns only the name and the two fee figures —
  // the dateline under the title needs start_date and end_date, which the RPC
  // does not select. Reading `seasons` from the player app is precedented
  // (/sessions, /feed, /my-stats, /tournaments, /announcements all do it).
  const seasonRes = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, competitive_fee_cents, recreational_fee_cents')
    .eq('active_flag', true)
    .maybeSingle();
  const season = unwrapMaybe<SeasonRow>(seasonRes);

  // What this member's own tier costs. The two tiers are keyed on
  // players.status (00001's player_status enum), NOT membership_type — 00040's
  // membership_type drives tournament ELIGIBILITY and which tournament fee tier
  // applies, and has no bearing on the season fee.
  const competitive = player.status === 'competitive';
  const seasonFeeCents = season
    ? competitive
      ? season.competitive_fee_cents
      : season.recreational_fee_cents
    : null;

  const lines: FeeLine[] = [];
  let seasonLine: FeeLine | null = null;

  // ── Club dues ─────────────────────────────────────────────────────────
  // club_fees is UNIQUE(player_id, season_id), so maybeSingle() is safe here.
  if (season && !exempt) {
    const clubFeeRes = await supabase
      .from('club_fees')
      .select('id, amount_cents, paid_at, method, reference')
      .eq('player_id', player.id)
      .eq('season_id', season.id)
      .maybeSingle();
    const clubFee = unwrapMaybe<ClubFeeRow>(clubFeeRes);
    const { paid, waived } = settlementOf(clubFee ?? {});
    seasonLine = {
      // A member with no row yet is the brand-new case: they owe the season fee
      // and there is no uuid to key on, so the season's id stands in.
      key: clubFee?.id ?? `season-${season.id}`,
      kind: 'season',
      name: `${season.name} membership`,
      // Once a row exists its own amount is the truth (a waived fee is stored as
      // 0, so the figure correctly reads $0.00); before that, the season's
      // per-status price is what will be charged.
      owedCents: clubFee?.paid_at != null ? clubFee.amount_cents : seasonFeeCents,
      paid,
      waived,
      paidAt: clubFee?.paid_at ?? null,
      method: clubFee?.method ?? null,
      reference: clubFee?.reference ?? null,
    };
    lines.push(seasonLine);
  }

  // ── Competition dues ──────────────────────────────────────────────────
  // Tournaments this member is entered in, singles (participants) and doubles
  // (pairs) alike.
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
      new Set([
        ...extractIds(unwrapMaybe<EventRefRow[]>(partRes)),
        ...extractIds(unwrapMaybe<EventRefRow[]>(pairRes)),
      ]),
    );

    if (tournamentIds.length > 0) {
      const [tournamentsRes, feesRes, tiersRes] = await Promise.all([
        supabase.from('tournaments').select('id, name').in('id', tournamentIds),
        supabase
          .from('tournament_fees')
          .select('id, tournament_id, amount_cents, paid_at, method, reference, tier_id')
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

      // tournament_fees is UNIQUE(tournament_id, player_id), so one entry per
      // tournament — keying the map on tournament_id cannot lose a row.
      const feeByTournament = new Map((fees ?? []).map((f) => [f.tournament_id, f]));
      const tierById = new Map((tiers ?? []).map((t) => [t.id, t]));
      const defaultTierByTournament = new Map(
        (tiers ?? []).filter((t) => t.is_default).map((t) => [t.tournament_id, t]),
      );

      const competitionLines: FeeLine[] = [];
      for (const t of tournaments) {
        const fee = feeByTournament.get(t.id);
        // Three places a price can come from, in descending order of authority.
        // All three can miss — a tournament with no fee row, no tier and no
        // default tier genuinely has no recorded price, and that stays null so
        // the total can say so rather than add a zero.
        let owedCents: number | null;
        if (fee?.amount_cents != null) {
          owedCents = fee.amount_cents;
        } else if (fee?.tier_id != null) {
          owedCents = tierById.get(fee.tier_id)?.amount_cents ?? null;
        } else {
          owedCents = defaultTierByTournament.get(t.id)?.amount_cents ?? null;
        }
        const { paid, waived } = settlementOf(fee ?? {});
        competitionLines.push({
          key: fee?.id ?? `tournament-${t.id}`,
          kind: 'tournament',
          name: t.name,
          owedCents,
          paid,
          waived,
          paidAt: fee?.paid_at ?? null,
          method: fee?.method ?? null,
          reference: fee?.reference ?? null,
        });
      }
      competitionLines.sort((a, b) => a.name.localeCompare(b.name));
      lines.push(...competitionLines);
    }
  }

  // ── Reinstatement ─────────────────────────────────────────────────────
  // A banned member is told on this page that money is owed. Before the
  // redesign that was a sentence with no figure beside it, which made the
  // banner a second, vaguer source of truth about what they owe. The rows are
  // real (reinstatement_fees), player-readable (rf_select_own) and 00065 keys
  // them per ban episode — so a member can legitimately have more than one, and
  // this is a list rather than a maybeSingle(). Charged regardless of
  // fee_exempt: exemption is from dues, and a reinstatement is not a due.
  const reinstatementRes = await supabase
    .from('reinstatement_fees')
    .select('id, amount_cents, paid_at, method, reference, created_at')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false });
  for (const r of unwrapMaybe<ReinstatementRow[]>(reinstatementRes) ?? []) {
    const { paid, waived } = settlementOf(r);
    lines.push({
      key: r.id,
      kind: 'reinstatement',
      name: 'Reinstatement fee',
      owedCents: r.amount_cents,
      paid,
      waived,
      paidAt: r.paid_at,
      method: r.method,
      reference: r.reference,
    });
  }

  const summary = summariseFees(lines, { exempt });
  const badge = headlineBadge(summary);
  const footer = outstandingFooter(exempt ? null : seasonLine, season?.end_date);
  const dateline = season ? seasonDateline(season.start_date, season.end_date) : null;

  return (
    <div className="fees wide-page" data-screen-label="Fees">
      <header className="fees-head wide-head">
        {/* /fees hangs off Settings — that is the only route in the app that
            links here — so the back link goes where the member came from. */}
        <Link href="/settings" className="fees-back">← SETTINGS</Link>
        <h1 className="fees-title">
          Fees<span className="dot">.</span>
        </h1>
        {season ? (
          <p className="fees-sub">
            {season.name}
            {dateline ? ` · ${dateline}` : ''}
          </p>
        ) : (
          <p className="fees-sub">No season is running, so no membership fee is being charged.</p>
        )}
      </header>

      <div className="fees-grid wide-grid">
        <div className="fees-col">
          {/* ── OUTSTANDING ───────────────────────────────────────────── */}
          <section className="card-base fees-card fees-outstanding">
            <div className="fees-label">Outstanding</div>
            <div className="fees-figure-row">
              <div className="fees-figure">{headlineAmount(summary)}</div>
              <Badge variant={badge.tone}>{badge.label}</Badge>
            </div>

            {summary.unknownCount > 0 && (
              // Never let the figure quietly under-report. An outstanding line
              // with no recorded price is added to nothing, so the total is a
              // floor and has to say so.
              <p className="fees-caveat">
                Plus {summary.unknownCount} {summary.unknownCount === 1 ? 'entry' : 'entries'} with no
                price recorded yet.
              </p>
            )}

            {summary.status === 'exempt' && (
              <p className="fees-caveat">
                {player.is_exec ? (
                  <>
                    Club and competition fees are not charged to the{' '}
                    <Link href="/exec" className="fees-link">
                      executive team
                    </Link>
                    .
                  </>
                ) : (
                  'You have been exempted from club and competition fees.'
                )}
              </p>
            )}

            {summary.outstanding.length > 0 && (
              <ul className="fees-owed">
                {summary.outstanding.map((l) => (
                  <li key={l.key} className="fees-owed-row">
                    <span className="fees-owed-name">{l.name}</span>
                    <span className="fees-owed-amount">{money(l.owedCents)}</span>
                  </li>
                ))}
              </ul>
            )}

            {footer && <div className="fees-foot">{footer}</div>}
          </section>

          {/* ── RECEIPTS ──────────────────────────────────────────────── */}
          <section className="fees-section">
            <h2 className="fees-section-label">Receipts</h2>
            {summary.receipts.length === 0 ? (
              <p className="fees-empty">
                Nothing recorded yet. An exec marks a fee paid once they have taken the money, and it
                appears here.
              </p>
            ) : (
              <ul className="fees-receipts">
                {summary.receipts.map((l) => {
                  const meta = receiptMeta(l);
                  return (
                    <li key={l.key} className="fees-receipt">
                      <div className="fees-receipt-main">
                        <div className="fees-receipt-name">{l.name}</div>
                        <div className="fees-receipt-meta">
                          {meta.text}
                          {meta.reference && (
                            <>
                              {meta.text && ' · '}
                              <Atomic>{meta.reference}</Atomic>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="fees-receipt-side">
                        <div className="fees-receipt-amount">{money(l.owedCents)}</div>
                        <div className={l.waived ? 'fees-receipt-state is-waived' : 'fees-receipt-state'}>
                          {l.waived ? 'WAIVED' : 'PAID'}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="fees-col">
          {/* ── WHAT THINGS COST ──────────────────────────────────────── */}
          <section className="card-base fees-card fees-prices">
            <div className="fees-label">What things cost</div>
            {season ? (
              <>
                {/* Both tiers, labelled, with the member's own marked. The
                    figures are the same two get_active_season() already hands
                    to anonymous visitors, so showing both discloses nothing —
                    and showing only one would hide that the club charges by
                    status at all. */}
                <div className="fees-price" data-mine={competitive ? 'true' : undefined}>
                  <div className="fees-price-main">
                    <div className="fees-price-name">
                      Competitive membership
                      {competitive && <span className="fees-yours">YOURS</span>}
                    </div>
                    <div className="fees-price-note">Rated ladder · one season</div>
                  </div>
                  <div className="fees-price-amount">{money(season.competitive_fee_cents)}</div>
                </div>
                <div className="fees-price" data-mine={!competitive ? 'true' : undefined}>
                  <div className="fees-price-main">
                    <div className="fees-price-name">
                      Recreational membership
                      {!competitive && <span className="fees-yours">YOURS</span>}
                    </div>
                    <div className="fees-price-note">Social play · one season</div>
                  </div>
                  <div className="fees-price-amount">{money(season.recreational_fee_cents)}</div>
                </div>
              </>
            ) : (
              <p className="fees-note">
                Membership prices are set per season, and no season is running.
              </p>
            )}
            {/* The mockup listed a flat "Tournament entry · $15". There is no
                such figure: tournament_fee_tiers prices every event separately,
                so the honest thing is to say so and let the real amounts appear
                above once the member has entered one. */}
            <p className="fees-note">
              Tournament entry is priced per event. Anything you have entered shows its own amount
              above.
            </p>
          </section>

          {/* ── CLOSING NOTE ──────────────────────────────────────────── */}
          <p className="fees-closing">
            IF PAYING IS A PROBLEM, WRITE TO{' '}
            <Link href="/exec" className="fees-link">
              THE EXEC
            </Link>
            .
            <br />
            HARDSHIP REQUESTS ARE ROUTINE AND PRIVATE.
          </p>
        </div>
      </div>
    </div>
  );
}
