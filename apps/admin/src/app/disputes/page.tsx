export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { formatDateShort as formatDate } from '@badminton/shared';
import { PageHero } from '@badminton/ui';
import { DisputeCard } from './dispute-card';

export default async function DisputesPage() {
  const supabase = createAdminClient();

  const { data: disputes } = await supabase
    .from('disputes')
    .select(
      'id, status, reason_category, description, created_at, resolution_type, resolution_note, match_id, opener:players!disputes_opened_by_fkey(full_name), match:matches(score_summary, match_type, format, played_at, match_participants(player_id, team_side, win_flag, submitted_score, player:players(full_name)))'
    )
    .order('created_at', { ascending: false })
    .limit(100);

  const openCount = (disputes ?? []).filter((d) => d.status === 'open').length;
  const resolvedCount = (disputes ?? []).length - openCount;
  const eyebrow =
    openCount > 0 || resolvedCount > 0
      ? `${openCount} open · ${resolvedCount} resolved`
      : 'All resolved';

  return (
    <div>
      <PageHero
        eyebrow={eyebrow}
        title="Disputes."
        subtitle="Score disagreements and no-shows. Resolve with the correct submission, or escalate for committee review."
        watermark="D"
      />

      {(disputes ?? []).map((d, idx) => {
        const opener = Array.isArray(d.opener) ? d.opener[0] : (d.opener as { full_name: string } | null);
        const match = Array.isArray(d.match) ? d.match[0] : (d.match as { score_summary?: string; match_type?: string; played_at?: string; match_participants?: Array<{ player: { full_name: string } | { full_name: string }[] | null; team_side: 'a' | 'b'; win_flag: boolean | null; submitted_score: string | null }> } | null);
        const parts = match?.match_participants ?? [];
        const partsByName = (side: 'a' | 'b') =>
          parts
            .filter((p) => p.team_side === side)
            .map((p) =>
              Array.isArray(p.player) ? p.player[0]?.full_name : p.player?.full_name
            )
            .filter(Boolean)
            .join(' & ') || '—';
        // Pick the per-side submitted_score; fall back to the canonical match score
        // when only one side has submitted (or both submitted the same).
        const submittedFor = (side: 'a' | 'b'): string => {
          const sub = parts.find((p) => p.team_side === side)?.submitted_score;
          return sub || match?.score_summary || '—';
        };

        const playersLine = `${partsByName('a')} vs ${partsByName('b')}`;
        const filedDate = formatDate(d.created_at as string);
        const matchDate = match?.played_at ? formatDate(match.played_at) : filedDate;
        const number = formatDisputeNumber(d.id as string, idx);

        const isResolved = d.status === 'resolved';
        const issue = humanizeReason(d.reason_category as string);
        const description = (d.description as string) ?? '';

        return (
          <DisputeCard
            key={d.id as string}
            disputeId={d.id as string}
            number={number}
            filedDate={filedDate}
            status={isResolved ? 'resolved' : 'open'}
            playersLine={playersLine}
            matchSubLabel={`Match · ${matchDate}`}
            issueValue={isResolved ? humanizeResolution(d.resolution_type as string) : issue}
            issueSub={description || (isResolved ? 'Resolution note on file.' : 'No additional notes.')}
            submissions={
              !isResolved && parts.length > 0
                ? [
                    {
                      name: `${partsByName('a')} submitted`,
                      score: submittedFor('a'),
                      result: parts.find((p) => p.team_side === 'a')?.win_flag ? 'Win' : 'Loss',
                    },
                    {
                      name: `${partsByName('b')} submitted`,
                      score: submittedFor('b'),
                      result: parts.find((p) => p.team_side === 'b')?.win_flag ? 'Win' : 'Loss',
                    },
                  ]
                : undefined
            }
            requestedOutcome={
              !isResolved && parts.length === 0
                ? {
                    value: opener
                      ? `Opener: ${opener.full_name}`
                      : 'Awaiting submission',
                  }
                : undefined
            }
            resolutionLine={
              isResolved && d.resolution_note
                ? (d.resolution_note as string)
                : undefined
            }
            outcomeLine={
              isResolved
                ? {
                    value: match?.score_summary || '—',
                    sub: 'ELO adjusted · audit entry on file.',
                  }
                : undefined
            }
            primaryActionLabel={`Resolve — Accept ${partsByName('a')}'s Score`}
            secondaryActionLabel={
              parts.length > 1 ? `Resolve — Accept ${partsByName('b')}'s Score` : undefined
            }
          />
        );
      })}

      {(!disputes || disputes.length === 0) && (
        <div
          style={{
            padding: '64px 48px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          No disputes have been filed.
        </div>
      )}
    </div>
  );
}

function formatDisputeNumber(id: string, idx: number): string {
  const tail = id.replace(/-/g, '').slice(-3).toUpperCase();
  return tail || String(idx + 1).padStart(3, '0');
}

function humanizeReason(category: string): string {
  switch (category) {
    case 'score_wrong':
      return 'Score disagreement — submitted scores do not match.';
    case 'winner_wrong':
      return 'Winner disagreement — opponent contested the result.';
    case 'format_wrong':
      return 'Format mismatch — submitted match format disputed.';
    case 'incomplete':
      return 'Match incomplete — opponent claims match was not finished.';
    case 'abuse':
      return 'Abuse / fraud reported.';
    case 'other':
      return 'Other dispute — see description.';
    default:
      return category ?? '—';
  }
}

function humanizeResolution(type: string): string {
  switch (type) {
    case 'accepted':
      return 'Admin accepted submission.';
    case 'edited':
      return 'Admin edited the score.';
    case 'voided':
      return 'Match voided.';
    case 'converted_to_casual':
      return 'Converted to casual (unrated).';
    default:
      return type ?? '—';
  }
}
