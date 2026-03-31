'use client';

import { useCallback } from 'react';
import { Download } from 'lucide-react';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  getRoundName,
} from '@badminton/shared';
import type { TournamentEventType, TournamentMatchFormat } from '@badminton/shared';

interface Props {
  tournament: { name: string; start_date: string };
  event: {
    event_type: TournamentEventType;
    match_format: TournamentMatchFormat;
    status: string;
  };
  matches: Array<{
    id: string;
    round_number: number;
    bracket_position: number;
    match_number: number;
    status: string;
    scores: Array<{ a: number; b: number }> | null;
    participant_a_id: string | null;
    participant_b_id: string | null;
    pair_a_id: string | null;
    pair_b_id: string | null;
    winner_participant_id: string | null;
    winner_pair_id: string | null;
  }>;
  participants: Array<{
    id: string;
    player: { full_name: string } | null;
    seed_number: number | null;
  }>;
  pairs: Array<{
    id: string;
    player1: { full_name: string } | null;
    player2: { full_name: string } | null;
    seed_number: number | null;
    pair_name: string | null;
  }>;
  isDoubles: boolean;
}

// Colors
const NAVY = '#1A1A2E';
const RED = '#E94560';
const LIGHT_GRAY = '#F3F4F6';
const MEDIUM_GRAY = '#9CA3AF';
const DARK_GRAY = '#374151';
const WHITE = '#FFFFFF';

export function DrawSheetPDF({
  tournament,
  event,
  matches,
  participants,
  pairs,
  isDoubles,
}: Props) {
  const getParticipantName = useCallback(
    (participantId: string | null, pairId: string | null): string => {
      if (isDoubles && pairId) {
        const pair = pairs.find((p) => p.id === pairId);
        if (!pair) return 'TBD';
        if (pair.pair_name) return pair.pair_name;
        const p1 = pair.player1?.full_name ?? '?';
        const p2 = pair.player2?.full_name ?? '?';
        return `${p1} / ${p2}`;
      }
      if (participantId) {
        const participant = participants.find((p) => p.id === participantId);
        return participant?.player?.full_name ?? 'TBD';
      }
      return 'BYE';
    },
    [isDoubles, pairs, participants],
  );

  const getSeedNumber = useCallback(
    (participantId: string | null, pairId: string | null): number | null => {
      if (isDoubles && pairId) {
        const pair = pairs.find((p) => p.id === pairId);
        return pair?.seed_number ?? null;
      }
      if (participantId) {
        const participant = participants.find((p) => p.id === participantId);
        return participant?.seed_number ?? null;
      }
      return null;
    },
    [isDoubles, pairs, participants],
  );

  const formatScore = (scores: Array<{ a: number; b: number }> | null): string => {
    if (!scores || scores.length === 0) return '';
    return scores.map((s) => `${s.a}-${s.b}`).join('  ');
  };

  const formatDate = (dateStr: string): string => {
    try {
      const date = new Date(dateStr + 'T00:00:00');
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const isRoundRobin = useCallback((): boolean => {
    if (matches.length === 0) return false;
    const rounds = new Set(matches.map((m) => m.round_number));
    if (rounds.size === 1) return true;
    // If all matches are round 1 and there are more matches than a single-elim R1 would have
    const round1Matches = matches.filter((m) => m.round_number === 1);
    const totalParticipants = isDoubles ? pairs.length : participants.length;
    return round1Matches.length > totalParticipants / 2;
  }, [matches, isDoubles, pairs.length, participants.length]);

  const generateSingleEliminationPDF = useCallback(
    async (doc: InstanceType<typeof import('jspdf').jsPDF>) => {
      const pageWidth = 297;
      const pageHeight = 210;
      const marginLeft = 10;
      const marginRight = 10;
      const headerHeight = 28;

      // --- Header ---
      doc.setFillColor(NAVY);
      doc.rect(0, 0, pageWidth, headerHeight, 'F');

      doc.setTextColor(WHITE);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('SFU BADMINTON CLUB', pageWidth / 2, 9, { align: 'center' });

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(tournament.name, pageWidth / 2, 16, { align: 'center' });

      doc.setFontSize(8);
      const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[event.event_type];
      const dateStr = formatDate(tournament.start_date);
      doc.text(`${eventLabel}  |  ${dateStr}`, pageWidth / 2, 22, {
        align: 'center',
      });

      // Accent line
      doc.setFillColor(RED);
      doc.rect(0, headerHeight, pageWidth, 1, 'F');

      // --- Bracket ---
      const sortedMatches = [...matches].sort((a, b) => {
        if (a.round_number !== b.round_number) return a.round_number - b.round_number;
        return a.bracket_position - b.bracket_position;
      });

      const totalRounds = Math.max(...sortedMatches.map((m) => m.round_number));
      const roundMatchCounts = new Map<number, number>();
      for (const m of sortedMatches) {
        roundMatchCounts.set(m.round_number, (roundMatchCounts.get(m.round_number) ?? 0) + 1);
      }

      const bracketTop = headerHeight + 6;
      const bracketBottom = pageHeight - 8;
      const bracketHeight = bracketBottom - bracketTop;
      const usableWidth = pageWidth - marginLeft - marginRight;

      // Column width per round, plus space for champion
      const championColWidth = 30;
      const colWidth = (usableWidth - championColWidth) / totalRounds;
      const matchBoxWidth = colWidth - 8;
      const matchBoxHeight = isDoubles ? 18 : 14;
      const nameRowHeight = isDoubles ? 8 : 6;

      // Draw round headers
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(NAVY);

      for (let r = 1; r <= totalRounds; r++) {
        const x = marginLeft + (r - 1) * colWidth + colWidth / 2;
        const roundLabel = getRoundName(r, totalRounds);
        doc.text(roundLabel, x, bracketTop, { align: 'center' });
      }

      // Champion header
      const championX = marginLeft + totalRounds * colWidth + championColWidth / 2;
      doc.setTextColor(RED);
      doc.text('CHAMPION', championX, bracketTop, { align: 'center' });

      const matchPositions = new Map<string, { x: number; y: number; height: number }>();

      // Draw matches per round
      for (let r = 1; r <= totalRounds; r++) {
        const roundMatches = sortedMatches
          .filter((m) => m.round_number === r)
          .sort((a, b) => a.bracket_position - b.bracket_position);
        const count = roundMatches.length;
        const colX = marginLeft + (r - 1) * colWidth + 4;
        const availableHeight = bracketHeight - 6;
        const spacing = count > 1 ? availableHeight / count : availableHeight / 2;
        const startY = bracketTop + 4 + (count === 1 ? (availableHeight - matchBoxHeight) / 2 : 0);

        for (let i = 0; i < roundMatches.length; i++) {
          const m = roundMatches[i];
          if (!m) continue;
          const y = count > 1 ? startY + i * spacing + (spacing - matchBoxHeight) / 2 : startY;

          matchPositions.set(`${m.round_number}-${m.bracket_position}`, {
            x: colX,
            y,
            height: matchBoxHeight,
          });

          // Match box background
          doc.setFillColor(WHITE);
          doc.setDrawColor(MEDIUM_GRAY);
          doc.setLineWidth(0.3);
          doc.roundedRect(colX, y, matchBoxWidth, matchBoxHeight, 1, 1, 'FD');

          // Match number badge
          doc.setFillColor(NAVY);
          doc.roundedRect(colX, y, 8, 5, 1, 1, 'F');
          doc.setTextColor(WHITE);
          doc.setFontSize(5);
          doc.setFont('helvetica', 'bold');
          doc.text(`M${m.match_number}`, colX + 4, y + 3.5, { align: 'center' });

          // Player A
          const seedA = getSeedNumber(m.participant_a_id, m.pair_a_id);
          const nameA = getParticipantName(m.participant_a_id, m.pair_a_id);
          const isWinnerA = isDoubles
            ? m.winner_pair_id === m.pair_a_id && m.pair_a_id !== null
            : m.winner_participant_id === m.participant_a_id && m.participant_a_id !== null;

          drawPlayerRow(doc, colX + 1, y + 5, matchBoxWidth - 2, nameRowHeight, {
            seed: seedA,
            name: nameA,
            isWinner: isWinnerA,
            isDoubles,
          });

          // Divider
          doc.setDrawColor(LIGHT_GRAY);
          doc.setLineWidth(0.2);
          doc.line(colX + 1, y + 5 + nameRowHeight, colX + matchBoxWidth - 1, y + 5 + nameRowHeight);

          // Player B
          const seedB = getSeedNumber(m.participant_b_id, m.pair_b_id);
          const nameB = getParticipantName(m.participant_b_id, m.pair_b_id);
          const isWinnerB = isDoubles
            ? m.winner_pair_id === m.pair_b_id && m.pair_b_id !== null
            : m.winner_participant_id === m.participant_b_id && m.participant_b_id !== null;

          drawPlayerRow(doc, colX + 1, y + 5 + nameRowHeight, matchBoxWidth - 2, nameRowHeight, {
            seed: seedB,
            name: nameB,
            isWinner: isWinnerB,
            isDoubles,
          });

          // Score
          if (m.scores && m.scores.length > 0) {
            const scoreStr = formatScore(m.scores);
            doc.setFontSize(4.5);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(MEDIUM_GRAY);
            doc.text(scoreStr, colX + matchBoxWidth - 2, y + 4, { align: 'right' });
          }
        }
      }

      // Draw connector lines between rounds
      doc.setDrawColor(MEDIUM_GRAY);
      doc.setLineWidth(0.3);

      for (let r = 1; r < totalRounds; r++) {
        const roundMatches = sortedMatches
          .filter((m) => m.round_number === r)
          .sort((a, b) => a.bracket_position - b.bracket_position);

        for (let i = 0; i < roundMatches.length; i += 2) {
          const m1 = roundMatches[i];
          const m2 = roundMatches[i + 1];
          if (!m1) continue;

          const pos1 = matchPositions.get(`${m1.round_number}-${m1.bracket_position}`);
          if (!pos1) continue;

          const midY1 = pos1.y + pos1.height / 2;
          const lineStartX = pos1.x + matchBoxWidth;

          if (m2) {
            const pos2 = matchPositions.get(`${m2.round_number}-${m2.bracket_position}`);
            if (!pos2) continue;
            const midY2 = pos2.y + pos2.height / 2;
            const connectorMidX = lineStartX + (colWidth - matchBoxWidth) / 2;

            // Horizontal from match 1
            doc.line(lineStartX, midY1, connectorMidX, midY1);
            // Horizontal from match 2
            doc.line(lineStartX, midY2, connectorMidX, midY2);
            // Vertical connecting
            doc.line(connectorMidX, midY1, connectorMidX, midY2);
            // Horizontal to next match
            const nextColX = marginLeft + r * colWidth + 4;
            const nextMidY = (midY1 + midY2) / 2;
            doc.line(connectorMidX, nextMidY, nextColX, nextMidY);
          } else {
            // Odd match, just draw line to next round
            const nextColX = marginLeft + r * colWidth + 4;
            doc.line(lineStartX, midY1, nextColX, midY1);
          }
        }
      }

      // Champion line from final
      const finalMatch = sortedMatches.find((m) => m.round_number === totalRounds);
      if (finalMatch) {
        const finalPos = matchPositions.get(
          `${finalMatch.round_number}-${finalMatch.bracket_position}`,
        );
        if (finalPos) {
          const finalMidY = finalPos.y + finalPos.height / 2;
          const lineStartX = finalPos.x + matchBoxWidth;
          const champX = marginLeft + totalRounds * colWidth;

          doc.setDrawColor(RED);
          doc.setLineWidth(0.5);
          doc.line(lineStartX, finalMidY, champX + championColWidth - 4, finalMidY);

          // Champion name
          const winnerId = isDoubles ? finalMatch.winner_pair_id : finalMatch.winner_participant_id;
          if (winnerId) {
            const championName = getParticipantName(
              isDoubles ? null : winnerId,
              isDoubles ? winnerId : null,
            );
            doc.setFontSize(7);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(RED);
            doc.text(championName, champX + championColWidth / 2, finalMidY - 2, {
              align: 'center',
            });

            // Trophy icon text
            doc.setFontSize(10);
            doc.text('\u2606', champX + championColWidth / 2, finalMidY + 5, {
              align: 'center',
            });
          } else {
            doc.setFontSize(6);
            doc.setFont('helvetica', 'italic');
            doc.setTextColor(MEDIUM_GRAY);
            doc.text('TBD', champX + championColWidth / 2, finalMidY - 1, { align: 'center' });
          }
        }
      }

      // Footer
      doc.setFontSize(5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(MEDIUM_GRAY);
      doc.text(
        `Generated ${new Date().toLocaleDateString('en-US')}  |  SFU Badminton Club`,
        pageWidth / 2,
        pageHeight - 3,
        { align: 'center' },
      );
    },
    [matches, tournament, event, isDoubles, getParticipantName, getSeedNumber],
  );

  const generateRoundRobinPDF = useCallback(
    async (doc: InstanceType<typeof import('jspdf').jsPDF>) => {
      const pageWidth = 297;
      const pageHeight = 210;
      const headerHeight = 28;

      // --- Header ---
      doc.setFillColor(NAVY);
      doc.rect(0, 0, pageWidth, headerHeight, 'F');

      doc.setTextColor(WHITE);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('SFU BADMINTON CLUB', pageWidth / 2, 9, { align: 'center' });

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(tournament.name, pageWidth / 2, 16, { align: 'center' });

      doc.setFontSize(8);
      const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[event.event_type];
      const dateStr = formatDate(tournament.start_date);
      doc.text(`${eventLabel}  |  Round Robin  |  ${dateStr}`, pageWidth / 2, 22, {
        align: 'center',
      });

      doc.setFillColor(RED);
      doc.rect(0, headerHeight, pageWidth, 1, 'F');

      // Build standings
      type Standing = {
        id: string;
        name: string;
        wins: number;
        losses: number;
        pointsFor: number;
        pointsAgainst: number;
      };

      const standingsMap = new Map<string, Standing>();

      const getEntryId = (m: (typeof matches)[0], side: 'a' | 'b'): string | null => {
        return isDoubles
          ? side === 'a'
            ? m.pair_a_id
            : m.pair_b_id
          : side === 'a'
            ? m.participant_a_id
            : m.participant_b_id;
      };

      // Initialize all participants
      if (isDoubles) {
        for (const pair of pairs) {
          const name = pair.pair_name ?? `${pair.player1?.full_name ?? '?'} / ${pair.player2?.full_name ?? '?'}`;
          standingsMap.set(pair.id, { id: pair.id, name, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
        }
      } else {
        for (const p of participants) {
          standingsMap.set(p.id, {
            id: p.id,
            name: p.player?.full_name ?? 'Unknown',
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0,
          });
        }
      }

      // Tally results
      for (const m of matches) {
        const idA = getEntryId(m, 'a');
        const idB = getEntryId(m, 'b');
        if (!idA || !idB) continue;

        const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
        if (winnerId && m.scores) {
          const entryA = standingsMap.get(idA);
          const entryB = standingsMap.get(idB);
          if (entryA && entryB) {
            let pfA = 0,
              pfB = 0;
            for (const s of m.scores) {
              pfA += s.a;
              pfB += s.b;
            }
            entryA.pointsFor += pfA;
            entryA.pointsAgainst += pfB;
            entryB.pointsFor += pfB;
            entryB.pointsAgainst += pfA;
            if (winnerId === idA) {
              entryA.wins++;
              entryB.losses++;
            } else {
              entryB.wins++;
              entryA.losses++;
            }
          }
        }
      }

      const standings = Array.from(standingsMap.values()).sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        const diffA = a.pointsFor - a.pointsAgainst;
        const diffB = b.pointsFor - b.pointsAgainst;
        return diffB - diffA;
      });

      // --- Standings Table ---
      const tableStartY = headerHeight + 8;
      const tableX = 15;
      const colWidths = [12, 80, 16, 16, 20, 20, 20];
      const tableWidth = colWidths.reduce((s, w) => s + w, 0);
      const rowHeight = 7;

      // Section header
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(NAVY);
      doc.text('STANDINGS', tableX, tableStartY);

      const thY = tableStartY + 4;

      // Table header
      doc.setFillColor(NAVY);
      doc.rect(tableX, thY, tableWidth, rowHeight, 'F');
      doc.setTextColor(WHITE);
      doc.setFontSize(6);
      doc.setFont('helvetica', 'bold');
      const headers = ['#', 'Player', 'W', 'L', 'PF', 'PA', '+/-'];
      let cx = tableX;
      for (let i = 0; i < headers.length; i++) {
        doc.text(headers[i], cx + 2, thY + 5);
        cx += colWidths[i];
      }

      // Table rows
      doc.setFont('helvetica', 'normal');
      for (let i = 0; i < standings.length; i++) {
        const s = standings[i];
        const ry = thY + rowHeight + i * rowHeight;

        if (i % 2 === 0) {
          doc.setFillColor(LIGHT_GRAY);
          doc.rect(tableX, ry, tableWidth, rowHeight, 'F');
        }

        doc.setTextColor(DARK_GRAY);
        doc.setFontSize(6);
        let rx = tableX;
        const diff = s.pointsFor - s.pointsAgainst;
        const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
        const rowData = [`${i + 1}`, s.name, `${s.wins}`, `${s.losses}`, `${s.pointsFor}`, `${s.pointsAgainst}`, diffStr];

        for (let j = 0; j < rowData.length; j++) {
          const text = rowData[j];
          const maxWidth = colWidths[j] - 4;
          // Truncate long names
          let displayText = text;
          if (j === 1 && doc.getTextWidth(text) > maxWidth) {
            while (doc.getTextWidth(displayText + '...') > maxWidth && displayText.length > 3) {
              displayText = displayText.slice(0, -1);
            }
            displayText += '...';
          }
          doc.text(displayText, rx + 2, ry + 5);
          rx += colWidths[j];
        }

        // Highlight rank 1
        if (i === 0) {
          doc.setDrawColor(RED);
          doc.setLineWidth(0.4);
          doc.rect(tableX, ry, tableWidth, rowHeight, 'S');
        }
      }

      // --- Match Schedule ---
      const scheduleStartY = thY + rowHeight + standings.length * rowHeight + 10;
      if (scheduleStartY < pageHeight - 30) {
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(NAVY);
        doc.text('MATCH SCHEDULE', tableX, scheduleStartY);

        const mHeaders = ['#', 'Player A', 'vs', 'Player B', 'Score', 'Status'];
        const mColWidths = [12, 60, 10, 60, 40, 24];
        const mTableWidth = mColWidths.reduce((s, w) => s + w, 0);
        const mThY = scheduleStartY + 4;

        doc.setFillColor(NAVY);
        doc.rect(tableX, mThY, mTableWidth, rowHeight, 'F');
        doc.setTextColor(WHITE);
        doc.setFontSize(6);
        doc.setFont('helvetica', 'bold');
        let mx = tableX;
        for (let i = 0; i < mHeaders.length; i++) {
          doc.text(mHeaders[i], mx + 2, mThY + 5);
          mx += mColWidths[i];
        }

        const sortedSchedule = [...matches].sort((a, b) => a.match_number - b.match_number);

        doc.setFont('helvetica', 'normal');
        for (let i = 0; i < sortedSchedule.length; i++) {
          const m = sortedSchedule[i];
          const ry = mThY + rowHeight + i * rowHeight;
          if (ry + rowHeight > pageHeight - 8) break; // Don't overflow page

          if (i % 2 === 0) {
            doc.setFillColor(LIGHT_GRAY);
            doc.rect(tableX, ry, mTableWidth, rowHeight, 'F');
          }

          doc.setTextColor(DARK_GRAY);
          doc.setFontSize(6);

          const nameA = getParticipantName(m.participant_a_id, m.pair_a_id);
          const nameB = getParticipantName(m.participant_b_id, m.pair_b_id);
          const score = formatScore(m.scores);
          const statusLabel = m.status === 'completed' ? 'Done' : m.status === 'live' ? 'Live' : '-';

          const rowData = [`M${m.match_number}`, nameA, 'vs', nameB, score || '-', statusLabel];
          let rx2 = tableX;
          for (let j = 0; j < rowData.length; j++) {
            let displayText = rowData[j];
            const maxW = mColWidths[j] - 4;
            if ((j === 1 || j === 3) && doc.getTextWidth(displayText) > maxW) {
              while (doc.getTextWidth(displayText + '...') > maxW && displayText.length > 3) {
                displayText = displayText.slice(0, -1);
              }
              displayText += '...';
            }
            doc.text(displayText, rx2 + 2, ry + 5);
            rx2 += mColWidths[j];
          }
        }
      }

      // Footer
      doc.setFontSize(5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(MEDIUM_GRAY);
      doc.text(
        `Generated ${new Date().toLocaleDateString('en-US')}  |  SFU Badminton Club`,
        pageWidth / 2,
        pageHeight - 3,
        { align: 'center' },
      );
    },
    [matches, tournament, event, isDoubles, pairs, participants, getParticipantName],
  );

  const handleDownload = useCallback(async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    if (isRoundRobin()) {
      await generateRoundRobinPDF(doc);
    } else {
      await generateSingleEliminationPDF(doc);
    }

    const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[event.event_type].replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `${tournament.name.replace(/[^a-zA-Z0-9]/g, '_')}_${eventLabel}_Draw_Sheet.pdf`;
    doc.save(fileName);
  }, [tournament, event, isRoundRobin, generateSingleEliminationPDF, generateRoundRobinPDF]);

  return (
    <button
      onClick={handleDownload}
      style={{
        background: 'var(--color-accent)',
        color: 'white',
        padding: '0.5rem 1rem',
        borderRadius: '0.5rem',
        fontSize: '0.8125rem',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.375rem',
        cursor: 'pointer',
        border: 'none',
      }}
    >
      <Download size={14} />
      Download Draw Sheet
    </button>
  );
}

function drawPlayerRow(
  doc: InstanceType<typeof import('jspdf').jsPDF>,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: {
    seed: number | null;
    name: string;
    isWinner: boolean;
    isDoubles: boolean;
  },
) {
  const { seed, name, isWinner } = opts;

  // Winner highlight
  if (isWinner) {
    doc.setFillColor('#FEF3C7');
    doc.rect(x, y, width, height, 'F');
  }

  // Seed badge
  let nameX = x + 1;
  if (seed !== null) {
    doc.setFontSize(4.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(RED);
    doc.text(`[${seed}]`, x + 1, y + height / 2 + 1.2);
    nameX = x + 8;
  }

  // Player name
  doc.setFontSize(5.5);
  doc.setFont('helvetica', isWinner ? 'bold' : 'normal');
  doc.setTextColor(isWinner ? NAVY : DARK_GRAY);

  const maxNameWidth = width - (nameX - x) - 2;
  let displayName = name;
  if (doc.getTextWidth(displayName) > maxNameWidth) {
    while (doc.getTextWidth(displayName + '...') > maxNameWidth && displayName.length > 3) {
      displayName = displayName.slice(0, -1);
    }
    displayName += '...';
  }
  doc.text(displayName, nameX, y + height / 2 + 1.2);
}
