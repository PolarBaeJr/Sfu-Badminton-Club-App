'use client';

import { useState } from 'react';
import { Button, Badge } from '@badminton/ui';
import { getRoundName } from '@badminton/shared';
import { ScoreEntryDialog } from './ScoreEntryDialog';
import { Trophy, ChevronRight } from 'lucide-react';
import type {
  TournamentMatchTabProps,
  TournamentMatch,
  TournamentParticipant,
  TournamentPair,
  TournamentGameScore,
} from '@/app/tournaments/types';

export function BracketTab({ event, matches, participants, pairs, isDoubles }: TournamentMatchTabProps) {
  const [scoreMatch, setScoreMatch] = useState<TournamentMatch | null>(null);
  const allMatches: TournamentMatch[] = matches;
  const isLive = event.status === 'live' || event.status === 'bracket_generated';

  if (allMatches.length === 0) {
    return (
      <div className=" border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Bracket not generated yet.</p>
      </div>
    );
  }

  // Group matches by round
  const rounds: Record<number, TournamentMatch[]> = {};
  for (const m of allMatches) {
    const r = (m.round_number ?? 0) as number;
    if (!rounds[r]) rounds[r] = [];
    rounds[r]!.push(m);
  }
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  const totalRounds = Math.max(...roundNumbers);

  // Build name lookup
  const nameMap: Record<string, string> = {};
  if (isDoubles) {
    for (const p of pairs as Array<TournamentPair & { pair_name?: string | null }>) {
      nameMap[p.id] = p.pair_name ?? `${p.player1?.full_name ?? '?'} / ${p.player2?.full_name ?? '?'}`;
    }
  } else {
    for (const p of participants) {
      nameMap[p.id] = p.player?.full_name ?? 'Unknown';
    }
  }

  // Seed lookup
  const seedMap: Record<string, number> = {};
  const seedSource: Array<TournamentParticipant | TournamentPair> = isDoubles ? pairs : participants;
  for (const p of seedSource) {
    if (p.seed_number) seedMap[p.id] = p.seed_number;
  }

  function getEntryName(id: string | null | undefined) {
    if (!id) return 'TBD';
    return nameMap[id] ?? 'TBD';
  }

  function getSeed(id: string | null | undefined) {
    if (!id) return null;
    return seedMap[id] ?? null;
  }

  return (
    <>
      <div className=" border border-[var(--border)] bg-[var(--bg-card)] p-4 overflow-x-auto" role="region" aria-label="Tournament bracket">
        <div className="flex gap-6 min-w-fit" role="table" aria-label="Bracket rounds">
          {roundNumbers.map((roundNum) => {
            const roundMatches = rounds[roundNum]!.sort(
              (a, b) => ((a.bracket_position as number | null) ?? 0) - ((b.bracket_position as number | null) ?? 0)
            );
            const roundName = roundMatches[0]?.round_name ?? getRoundName(roundNum, totalRounds);

            return (
              <div key={roundNum} className="flex flex-col min-w-[260px]" role="rowgroup" aria-label={roundName} style={{ gap: `${Math.pow(2, roundNum - 1) * 0.5}rem` }}>
                <h3 className="text-xs font-bold text-[var(--text-muted)] text-center uppercase tracking-wider mb-2" role="columnheader">
                  {roundName}
                </h3>
                {roundMatches.map((m) => {
                  const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
                  const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
                  const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
                  const isCompleted = m.status === 'completed' || m.status === 'walkover';
                  const isBye = m.is_bye;
                  const isReady = m.status === 'ready' && aId && bId;
                  const canEnterScore = isLive && (isReady || m.status === 'live' || m.status === 'pending') && aId && bId && !isCompleted && !isBye;

                  return (
                    <div
                      key={m.id}
                      role="row"
                      aria-label={`Match ${m.match_number ?? ''}: ${getEntryName(aId)} vs ${getEntryName(bId)}${isCompleted ? `, winner: ${getEntryName(winnerId)}` : ''}`}
                      className={` border overflow-hidden transition-all ${
                        isReady && isLive
                          ? 'border-[var(--ds-accent)]/40 shadow-[0_0_8px_rgba(0,229,160,0.15)]'
                          : isBye
                          ? 'border-[var(--border)] opacity-50'
                          : 'border-[var(--border)]'
                      }`}
                    >
                      {/* Match number */}
                      {m.match_number && (
                        <div className="text-[10px] text-[var(--text-muted)] text-center py-0.5 bg-[var(--bg-elevated)] border-b border-[var(--border)] font-mono">
                          M{m.match_number}{m.court ? ` · Court ${m.court}` : ''}
                        </div>
                      )}

                      {/* Side A */}
                      <div className={`px-3 py-2 flex items-center justify-between text-sm ${
                        isCompleted && winnerId === aId ? 'bg-[var(--color-success)]/10' : 'bg-[var(--bg-card)]'
                      }`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isCompleted && winnerId === aId && (
                            <span aria-hidden="true" className="text-[var(--color-success)] font-bold">✓</span>
                          )}
                          {getSeed(aId) && <span className="text-[10px] font-mono text-[var(--text-muted)]">[{getSeed(aId)}]</span>}
                          <span className={`truncate ${
                            isCompleted && winnerId === aId
                              ? 'text-[var(--color-success)] font-semibold'
                              : isCompleted && winnerId === bId
                              ? 'text-[var(--text-muted)] line-through'
                              : 'text-[var(--text-secondary)]'
                          }`}>
                            {isBye && !aId ? 'BYE' : getEntryName(aId)}
                          </span>
                          {isCompleted && winnerId === aId && <span className="sr-only">(Winner)</span>}
                        </div>
                        {m.scores && (
                          <span className="font-mono text-xs text-[var(--text-muted)] ml-2">
                            {(m.scores ?? []).map((g: TournamentGameScore) => `${g.a}-${g.b}`).join(', ')}
                          </span>
                        )}
                      </div>

                      <div className="border-t border-[var(--border)]" />

                      {/* Side B */}
                      <div className={`px-3 py-2 flex items-center justify-between text-sm ${
                        isCompleted && winnerId === bId ? 'bg-[var(--color-success)]/10' : 'bg-[var(--bg-card)]'
                      }`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isCompleted && winnerId === bId && (
                            <span aria-hidden="true" className="text-[var(--color-success)] font-bold">✓</span>
                          )}
                          {getSeed(bId) && <span className="text-[10px] font-mono text-[var(--text-muted)]">[{getSeed(bId)}]</span>}
                          <span className={`truncate ${
                            isCompleted && winnerId === bId
                              ? 'text-[var(--color-success)] font-semibold'
                              : isCompleted && winnerId === aId
                              ? 'text-[var(--text-muted)] line-through'
                              : 'text-[var(--text-secondary)]'
                          }`}>
                            {isBye && !bId ? 'BYE' : getEntryName(bId)}
                          </span>
                          {isCompleted && winnerId === bId && <span className="sr-only">(Winner)</span>}
                        </div>
                        {m.scores && (
                          <span className="font-mono text-xs text-[var(--text-muted)] ml-2">
                            {(m.scores ?? []).map((g: TournamentGameScore) => `${g.b}-${g.a}`).join(', ')}
                          </span>
                        )}
                      </div>

                      {/* Enter Score button */}
                      {canEnterScore && (
                        <button
                          onClick={() => setScoreMatch(m)}
                          aria-label={`Enter score for match ${m.match_number ?? ''}`}
                          className="w-full text-center text-xs text-[var(--ds-accent)] py-1.5 bg-[var(--bg-elevated)] hover:bg-[var(--ds-accent)]/10 transition-colors border-t border-[var(--border)] font-medium focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none"
                        >
                          Enter Score
                        </button>
                      )}

                      {/* Status badges */}
                      {m.status === 'walkover' && (
                        <div className="text-center py-1 border-t border-[var(--border)]">
                          <span className="text-[10px] text-[var(--color-warning)] font-medium" role="status">⚠ W/O WALKOVER</span>
                        </div>
                      )}
                      {m.status === 'voided' && (
                        <div className="text-center py-1 border-t border-[var(--border)]">
                          <span className="text-[10px] text-[var(--color-danger)] font-medium" role="status">✕ VOIDED</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          onClose={() => setScoreMatch(null)}
        />
      )}
    </>
  );
}
