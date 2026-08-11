import { AvatarChip } from '@badminton/ui';

// The right-hand column of /ratings: what these settings reach, and who last
// moved them.
//
// THE DESIGN ASKED FOR A LIVE RECALCULATION PREVIEW — "168 ratings
// recalculated, biggest rise +31, biggest fall -28, 22 rank changes". There is
// nothing in this product that recalculates a rating. Saving a K-factor changes
// what the NEXT confirmed match does; every rating already on the ladder is
// untouched, so the honest preview of a settings change is not a small number,
// it is zero. The only thing that ever rewrites every rating at once is
// activate_season, and that is a different screen and a different decision.
//
// So the card says what is true: how many members these settings will apply
// to, how many of them the placement-match threshold still moves on the
// provisional K-factors, and when a season was last activated — the only
// operation in the product that touches every rating at once. No invented
// deltas.

/** Each block is either shown, withheld from this viewer, or genuinely empty. */
export type Withheld = { state: 'withheld' };

export type LadderShape =
  | Withheld
  | {
      state: 'ok';
      total: number;
      /** On the provisional K-factors right now — see loadLadder(). */
      singlesProvisional: number;
      doublesProvisional: number;
    };

export type LastActivation = Withheld | { state: 'none' } | { state: 'ok'; at: string };

export type LastChange =
  | Withheld
  | { state: 'none' }
  | {
      state: 'ok';
      settingKey: string;
      at: string;
      /** Null when the roster is not shown to this viewer, or the actor is gone. */
      who: { id: string; name: string; avatar: string | null } | null;
      whoWithheld: boolean;
      /** The officer's own words. Null when nothing was typed. */
      reason: string | null;
      reasonWithheld: boolean;
      /** field → old → new, read off the audit row. Empty when unknown. */
      diff: { label: string; from: string; to: string }[];
    };

const MONO_LABEL =
  'font-mono text-[10px] uppercase tracking-[.14em] text-[var(--mute)]';

function formatDay(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    .toUpperCase();
}

function CardShell({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border border-[var(--line)] bg-[var(--surface)]">
      <h2 className={`${MONO_LABEL} tracking-[.16em] px-4 pt-4 pb-3`}>{heading}</h2>
      {children}
    </section>
  );
}

function NotShown({ what }: { what: string }) {
  // Never a blank panel — a blank panel reads as broken. Say who it is not for.
  return <p className="px-4 pb-4 text-[13px] text-[var(--mute)]">{what}</p>;
}

export function RatingsAside({
  ladder,
  lastActivation,
  lastChange,
}: {
  ladder: LadderShape;
  lastActivation: LastActivation;
  lastChange: LastChange;
}) {
  return (
    <div className="flex flex-col gap-5 xl:sticky xl:top-5 xl:self-start">
      <CardShell heading="What these settings touch">
        {ladder.state === 'withheld' ? (
          <NotShown what="The size of the ladder is not shown to you." />
        ) : (
          <>
            <div className="flex items-baseline gap-3 px-4 pb-4">
              <span className="font-mono text-[36px] leading-none tracking-[-.03em] text-[var(--ink)]">
                {ladder.total}
              </span>
              <span className={MONO_LABEL}>
                {ladder.total === 1 ? 'member on the ladder' : 'members on the ladder'}
              </span>
            </div>

            <dl className="border-t border-[var(--line)] px-4 py-3 text-[13px]">
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className={MONO_LABEL}>Provisional · singles</dt>
                <dd className="font-mono text-[var(--ink)]">{ladder.singlesProvisional}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className={MONO_LABEL}>Provisional · doubles</dt>
                <dd className="font-mono text-[var(--ink)]">{ladder.doublesProvisional}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1">
                {/* NOT "ladder last rewritten": activate_season snapshots the
                    outgoing season whatever Elo policy it is given, and the
                    default policy ('carry') rewrites nothing. The date proves
                    an activation happened, so that is what it is called. */}
                <dt className={MONO_LABEL}>Season last activated</dt>
                <dd className="font-mono text-right text-[var(--ink)]">
                  {lastActivation.state === 'withheld'
                    ? '—'
                    : lastActivation.state === 'none'
                      ? 'NEVER'
                      : formatDay(lastActivation.at)}
                </dd>
              </div>
            </dl>
          </>
        )}

        <p className={`${MONO_LABEL} border-t border-[var(--line)] px-4 py-3 leading-[1.6]`}>
          These settings apply to matches confirmed from now on. Nothing here
          recalculates a rating that is already recorded — only activating a
          season on a soft or full Elo policy rewrites the ladder.
        </p>
      </CardShell>

      <CardShell heading="Last changed">
        {lastChange.state === 'withheld' ? (
          <NotShown what="Who last changed these settings is not shown to you." />
        ) : lastChange.state === 'none' ? (
          <NotShown what="Nothing on this page has been changed since the club launched." />
        ) : (
          <div className="border-t border-[var(--line)] px-4 py-4">
            <div className="flex items-start gap-3">
              {lastChange.who && (
                <AvatarChip name={lastChange.who.name} id={lastChange.who.id} src={lastChange.who.avatar} size="sm" />
              )}
              <div className="min-w-0">
                <p className="text-[14px] text-[var(--ink)]">
                  {lastChange.who
                    ? lastChange.who.name
                    : lastChange.whoWithheld
                      ? 'Name not shown to you'
                      : 'A former officer'}
                </p>
                <p className={`${MONO_LABEL} mt-1 leading-[1.6]`}>
                  {formatDay(lastChange.at)} · {lastChange.settingKey}
                  {lastChange.diff.map((d) => (
                    <span key={d.label} className="block">
                      {d.label} {d.from} → {d.to}
                    </span>
                  ))}
                </p>
              </div>
            </div>

            {lastChange.reasonWithheld ? (
              <p className="mt-3 text-[13px] text-[var(--mute)]">
                The reason they typed is in the audit log, which is not shown to you.
              </p>
            ) : lastChange.reason ? (
              <p className="mt-3 text-[13px] leading-[1.5] text-[var(--ink-2)]">
                &ldquo;{lastChange.reason}&rdquo;
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-[var(--mute)]">
                No reason was typed — this change predates the reason box.
              </p>
            )}
          </div>
        )}
      </CardShell>
    </div>
  );
}
