'use client';

import { useState } from 'react';
import { Button, Card, Input, Select, Dialog, Textarea } from '@badminton/ui';
import { acceptChallenge, rejectChallenge, submitMatchResult, confirmMatchResult, disputeMatchResult, reportWalkover, cancelChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

interface Props {
  challengeId: string;
  challengeStatus: string;
  matchId: string | undefined;
  matchStatus: string | undefined;
  myParticipantStatus: string | undefined;
  isCreator: boolean;
  format: string;
  participants: Record<string, unknown>[];
  playerId: string;
}

export function ChallengeDetailActions({
  challengeId, challengeStatus, matchId, matchStatus,
  myParticipantStatus, isCreator, format, participants, playerId,
}: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const [loading, setLoading] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [showWalkover, setShowWalkover] = useState(false);

  // Score submission state
  const isBO3 = format === 'bo3_21';
  const [games, setGames] = useState(
    isBO3
      ? [{ game_number: 1, side_a_score: 0, side_b_score: 0 }, { game_number: 2, side_a_score: 0, side_b_score: 0 }, { game_number: 3, side_a_score: 0, side_b_score: 0 }]
      : [{ game_number: 1, side_a_score: 0, side_b_score: 0 }]
  );
  const [winnerSide, setWinnerSide] = useState<'a' | 'b'>('a');

  // Dispute state
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeCategory, setDisputeCategory] = useState('score_wrong');

  // Derived team labels from participants
  const teamA = participants.filter((p) => p.team_side === 'a');
  const teamB = participants.filter((p) => p.team_side === 'b');
  const myTeamSide = participants.find((p) => p.player_id === playerId)?.team_side as 'a' | 'b' | undefined;

  const formatTeam = (team: Record<string, unknown>[]) =>
    team
      .map((p) => (p.player as Record<string, unknown> | null)?.full_name as string | undefined)
      .filter(Boolean)
      .join(' + ') || 'Unknown';

  const teamALabel = formatTeam(teamA);
  const teamBLabel = formatTeam(teamB);
  const labelA = myTeamSide === 'a' ? `Your team (${teamALabel})` : teamALabel;
  const labelB = myTeamSide === 'b' ? `Your team (${teamBLabel})` : teamBLabel;
  const compactA = teamALabel.length > 20 ? 'Team A' : teamALabel;
  const compactB = teamBLabel.length > 20 ? 'Team B' : teamBLabel;

  async function handleAction(action: string) {
    setLoading(action);
    try {
      if (action === 'accept') {
        await acceptChallenge(challengeId);
        toast('Challenge accepted!', 'success');
      } else if (action === 'reject') {
        await rejectChallenge(challengeId);
        toast('Challenge rejected', 'info');
      } else if (action === 'confirm') {
        if (!matchId) return;
        await confirmMatchResult(matchId);
        toast('Result confirmed! Elo updated.', 'success');
      } else if (action === 'cancel') {
        if (!confirm('Cancel this challenge? The opponent will be notified.')) { setLoading(''); return; }
        await cancelChallenge(challengeId);
        toast('Challenge cancelled', 'info');
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading('');
  }

  async function handleSubmitResult() {
    setLoading('submit');
    try {
      const validGames = isBO3 ? games.filter((g, i) => i < 2 || (g.side_a_score > 0 || g.side_b_score > 0)) : games;
      await submitMatchResult(challengeId, {
        winner_side: winnerSide,
        games: validGames,
        completed: true,
      });
      toast('Result submitted! Waiting for confirmation.', 'success');
      setShowSubmit(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading('');
  }

  async function handleDispute() {
    if (!disputeReason.trim()) { toast('Reason required', 'error'); return; }
    if (!matchId) return;
    setLoading('dispute');
    try {
      await disputeMatchResult(matchId, disputeReason, disputeCategory);
      toast('Dispute opened', 'info');
      setShowDispute(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading('');
  }

  async function handleWalkover(type: 'no_show' | 'withdrawal') {
    setLoading('walkover');
    try {
      // Withdrawals: self forfeits. No-shows: an opposing-team participant didn't show.
      // Server re-validates that forfeit_player is on the correct team for the type.
      let forfeitPlayerId: string | undefined;
      if (type === 'withdrawal') {
        forfeitPlayerId = playerId;
      } else {
        const myTeam = participants.find((pp) => pp.player_id === playerId)?.team_side;
        const opponent = participants.find((p) => p.player_id !== playerId && p.team_side !== myTeam);
        forfeitPlayerId = opponent?.player_id as string | undefined;
      }
      if (!forfeitPlayerId) {
        toast('Could not determine forfeit player', 'error');
        setLoading('');
        return;
      }
      await reportWalkover({
        challenge_id: challengeId,
        forfeit_player_id: forfeitPlayerId,
        walkover_type: type,
      });
      toast('Walkover reported. Admin will review.', 'info');
      setShowWalkover(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading('');
  }

  return (
    <div className="space-y-3">
      {/* Cancel Challenge for creator while still pending */}
      {isCreator && ['proposed', 'partially_confirmed'].includes(challengeStatus) && (
        <Button
          onClick={() => handleAction('cancel')}
          loading={loading === 'cancel'}
          variant="ghost"
          className="w-full"
        >
          Cancel Challenge
        </Button>
      )}

      {/* Accept/Reject for pending participants */}
      {myParticipantStatus === 'pending' && ['proposed', 'partially_confirmed'].includes(challengeStatus) && (
        <div className="flex gap-3">
          <Button onClick={() => handleAction('accept')} loading={loading === 'accept'} className="flex-1" variant="success">
            Accept
          </Button>
          <Button onClick={() => handleAction('reject')} loading={loading === 'reject'} className="flex-1" variant="danger">
            Reject
          </Button>
        </div>
      )}

      {/* Submit Result for accepted challenges without a match */}
      {challengeStatus === 'accepted' && !matchId && (
        <div className="flex gap-3">
          <Button onClick={() => setShowSubmit(true)} className="flex-1">Submit Result</Button>
          <Button onClick={() => setShowWalkover(true)} variant="ghost" className="flex-1">Report Issue</Button>
        </div>
      )}

      {/* Confirm/Dispute for pending_confirmation matches */}
      {matchStatus === 'pending_confirmation' && matchId && (
        <div className="flex gap-3">
          <Button onClick={() => handleAction('confirm')} loading={loading === 'confirm'} className="flex-1" variant="success">
            Confirm Result
          </Button>
          <Button onClick={() => setShowDispute(true)} variant="danger" className="flex-1">
            Dispute
          </Button>
        </div>
      )}

      {/* Submit Result Dialog */}
      <Dialog open={showSubmit} onClose={() => setShowSubmit(false)} title="Submit Match Result">
        <div className="space-y-4">
          <Select
            label="Winner"
            value={winnerSide}
            onChange={(e) => setWinnerSide(e.target.value as 'a' | 'b')}
            options={[
              { value: 'a', label: labelA },
              { value: 'b', label: labelB },
            ]}
          />
          {games.map((g, i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Input
                label={`Game ${g.game_number} — ${compactA}`}
                type="number"
                min={0}
                value={g.side_a_score}
                onChange={(e) => {
                  const updated = [...games];
                  updated[i] = { ...g, side_a_score: parseInt(e.target.value) || 0 };
                  setGames(updated);
                }}
              />
              <Input
                label={`Game ${g.game_number} — ${compactB}`}
                type="number"
                min={0}
                value={g.side_b_score}
                onChange={(e) => {
                  const updated = [...games];
                  updated[i] = { ...g, side_b_score: parseInt(e.target.value) || 0 };
                  setGames(updated);
                }}
              />
            </div>
          ))}
          <Button onClick={handleSubmitResult} loading={loading === 'submit'} className="w-full press">
            Submit
          </Button>
        </div>
      </Dialog>

      {/* Dispute Dialog */}
      <Dialog open={showDispute} onClose={() => setShowDispute(false)} title="Dispute Result">
        <div className="space-y-4">
          <Select
            label="Reason"
            value={disputeCategory}
            onChange={(e) => setDisputeCategory(e.target.value)}
            options={[
              { value: 'score_wrong', label: 'Score is wrong' },
              { value: 'winner_wrong', label: 'Winner is wrong' },
              { value: 'format_wrong', label: 'Wrong format' },
              { value: 'incomplete', label: 'Match was incomplete' },
              { value: 'abuse', label: 'Abuse/fraud' },
              { value: 'other', label: 'Other' },
            ]}
          />
          <Textarea
            label="Description"
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Describe the issue..."
          />
          <Button onClick={handleDispute} loading={loading === 'dispute'} variant="danger" className="w-full press">
            Open Dispute
          </Button>
        </div>
      </Dialog>

      {/* Walkover Dialog */}
      <Dialog open={showWalkover} onClose={() => setShowWalkover(false)} title="Report Issue">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-muted)]">What happened?</p>
          <Button onClick={() => handleWalkover('no_show')} loading={loading === 'walkover'} variant="danger" className="w-full press">
            Opponent No-Show
          </Button>
          <Button onClick={() => handleWalkover('withdrawal')} loading={loading === 'walkover'} variant="ghost" className="w-full press">
            I Need to Withdraw
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
