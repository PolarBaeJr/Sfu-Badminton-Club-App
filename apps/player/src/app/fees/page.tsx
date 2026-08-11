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
type TournamentRow = { id: string; name: string };
/**
 * One row of the club's one fee ledger (00094).
 *
 * This used to be three shapes off three tables. They were always the same
 * five money columns plus something naming what the money was for; fee_type is
 * that something, and it is the only field below that decides how a row is
 * read.
 */
type FeeRow = {
  id: string;
  fee_type: 'dues' | 'tournament' | 'reinstatement';
  season_id: string | null;
  tournament_id: string | null;
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
  //   1. an explicit .eq('player_id', player.id) on the fee ledger, and
  //   2. RLS — club_fees_select_own in 00005_rls.sql,
  //      USING (player_id = get_player_id(auth.uid())).
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
  // Which tier to MARK as the member's own, which is not the same question.
  // player_status also has 'pending_approval' and 'suspended', and neither is a
  // fee tier. The amount above falls through to the recreational figure for
  // them (unchanged from before the redesign), but printing "YOURS" beside a
  // tier they have not been placed in would be an assertion the roster does not
  // make.
  const ownTier = competitive
    ? 'competitive'
    : player.status === 'recreational'
      ? 'recreational'
      : null;

  // ── EVERYTHING THIS MEMBER OWES, IN ONE READ ──────────────────────────
  // Dues, entry fees and reinstatements are one table since 00094, so this
  // screen no longer has to know that they were ever three. What it replaced:
  // a club_fees query, a walk of tournament_participants and tournament_pairs
  // to work out which tournaments the member had entered, a tournament_fees
  // query, a tournament_fee_tiers query to guess a price for entries with no
  // fee row, and a reinstatement_fees query. Six reads and a three-level price
  // fallback, all of it reconstructing what the ledger now simply states.
  //
  // ONE CONSEQUENCE, WORTH KNOWING: an entry with no fee row is not shown. That
  // used to be derivable from the participant rows; it is not any more, and it
  // is the right trade — the price came from a tier the club might have
  // changed since, so the figure shown was a guess dressed as a statement. Every
  // entry made from now on has a row (ensureEntryFees writes one at
  // registration) and the ones made before it are backfilled by the data
  // migration.
  const feesRes = await supabase
    .from('club_fees')
    .select(
      'id, fee_type, season_id, tournament_id, amount_cents, paid_at, method, reference, created_at',
    )
    .eq('player_id', player.id)
    .order('created_at', { ascending: false });
  const feeRows = unwrapMaybe<FeeRow[]>(feesRes) ?? [];

  const lines: FeeLine[] = [];
  let seasonLine: FeeLine | null = null;

  // ── Club dues ─────────────────────────────────────────────────────────
  // club_fees_dues_player_season_key (00094) keeps this at one row per member
  // per season, so find() cannot be hiding a second one.
  if (season && !exempt) {
    const clubFee = feeRows.find((f) => f.fee_type === 'dues' && f.season_id === season.id);
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
      recordedCents: clubFee?.amount_cents ?? null,
      paid,
      waived,
      paidAt: clubFee?.paid_at ?? null,
      method: clubFee?.method ?? null,
      reference: clubFee?.reference ?? null,
    };
    lines.push(seasonLine);
  }

  // ── Competition dues ──────────────────────────────────────────────────
  // The entry fees already in `feeRows`, named. The only extra read the whole
  // screen still makes is the tournaments' NAMES — a fee row knows which
  // tournament it is for, not what that tournament is called, and "Fall Open"
  // is what a member recognises.
  //
  // The price is the row's own amount_cents and nothing else. It was snapshotted
  // from the matching tier at entry (selectFeeTier), so there is no fallback
  // chain left to get wrong, and re-deriving it here would mean a member who
  // changed membership group saw a different figure from the one the club has
  // on its books.
  const entryFees = feeRows.filter((f) => f.fee_type === 'tournament' && f.tournament_id);
  if (entryFees.length > 0) {
    const tournaments = unwrap<TournamentRow[]>(
      await supabase
        .from('tournaments')
        .select('id, name')
        .in('id', [...new Set(entryFees.map((f) => f.tournament_id as string))]),
    );
    const nameById = new Map(tournaments.map((t) => [t.id, t.name]));

    const competitionLines = entryFees.map((fee) => {
      const { paid, waived } = settlementOf(fee);
      return {
        key: fee.id,
        kind: 'tournament' as const,
        // A tournament the member can no longer read — deleted, or outside
        // whatever the tournaments policy allows — still has a real fee on
        // their ledger. Naming it generically beats dropping the line.
        name: nameById.get(fee.tournament_id as string) ?? 'Tournament entry',
        owedCents: fee.amount_cents,
        recordedCents: fee.amount_cents,
        paid,
        waived,
        paidAt: fee.paid_at,
        method: fee.method,
        reference: fee.reference,
      };
    });
    competitionLines.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(...competitionLines);
  }

  // ── Reinstatement ─────────────────────────────────────────────────────
  // A banned member is told on this page that money is owed. Before the
  // redesign that was a sentence with no figure beside it, which made the
  // banner a second, vaguer source of truth about what they owe. 00094 keys
  // these per ban episode — so a member can legitimately have more than one,
  // and this is a list rather than one row. Charged regardless of fee_exempt:
  // exemption is from dues, and a reinstatement is not a due.
  for (const r of feeRows.filter((f) => f.fee_type === 'reinstatement')) {
    const { paid, waived } = settlementOf(r);
    lines.push({
      key: r.id,
      kind: 'reinstatement',
      name: 'Reinstatement fee',
      owedCents: r.amount_cents,
      recordedCents: r.amount_cents,
      paid,
      waived,
      paidAt: r.paid_at,
      method: r.method,
      reference: r.reference,
    });
  }

  const summary = summariseFees(lines, { exempt });
  const badge = headlineBadge(summary);
  const footer = outstandingFooter(seasonLine, season?.end_date);
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
          <section className="card-base fees-outstanding">
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

            {/* Keyed off `exempt`, not off status === 'exempt'. An exempt member
                with an unpaid reinstatement fee reads as 'owing', and the
                sentence explaining why no dues are listed is exactly what stops
                that figure looking like a term fee. */}
            {exempt && (
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

            {/* Only when the figure is a sum of more than one thing. With a
                single outstanding line the breakdown is the headline printed
                twice, which is what the mockup avoided by only ever having a
                term fee to show. */}
            {summary.outstanding.length > 1 && (
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
                        {/* recordedCents, not owedCents. A receipt states what
                            the club recorded taking; owedCents can fall back to
                            a tier's list price, and printing that beside "PAID"
                            would assert a figure nobody entered. */}
                        <div className="fees-receipt-amount">{money(l.recordedCents)}</div>
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
          <section className="card-base fees-prices">
            <div className="fees-label">What things cost</div>
            {season ? (
              <>
                {/* Both tiers, labelled, with the member's own marked. The
                    figures are the same two get_active_season() already hands
                    to anonymous visitors, so showing both discloses nothing —
                    and showing only one would hide that the club charges by
                    status at all. */}
                <div className="fees-price" data-mine={ownTier === 'competitive' ? 'true' : undefined}>
                  <div className="fees-price-main">
                    <div className="fees-price-name">
                      Competitive membership
                      {ownTier === 'competitive' && <span className="fees-yours">YOURS</span>}
                    </div>
                    {/* What the two tiers actually mean, from the schema and
                        not from the mockup: 00001's session_group enum sets a
                        session's track to competitive / recreational / all, so
                        the status decides which sessions are aimed at you. */}
                    <div className="fees-price-note">Competitive sessions · one season</div>
                  </div>
                  <div className="fees-price-amount">{money(season.competitive_fee_cents)}</div>
                </div>
                <div className="fees-price" data-mine={ownTier === 'recreational' ? 'true' : undefined}>
                  <div className="fees-price-main">
                    <div className="fees-price-name">
                      Recreational membership
                      {ownTier === 'recreational' && <span className="fees-yours">YOURS</span>}
                    </div>
                    <div className="fees-price-note">Recreational sessions · one season</div>
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
