'use client';

import { useState } from 'react';
import { Button, Card, Input, Select, Dialog, Textarea, useConfirm } from '@badminton/ui';
import { tallyGames } from '@badminton/shared';
import { acceptChallenge, rejectChallenge, submitMatchResult, confirmMatchResult, disputeMatchResult, reportWalkover, cancelChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { useLiveMatches } from '@/components/live-matches';
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
  /** True when the signed-in player is the one who submitted the result. */
  isSubmitter: boolean;
}

export function ChallengeDetailActions({
  challengeId, challengeStatus, matchId, matchStatus,
  myParticipantStatus, isCreator, format, participants, playerId, isSubmitter,
}: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // Every action below goes through requirePlayer(): accept, reject, cancel,
  // submit result, confirm, dispute, walkover. None of them will run for an
  // account in bad standing, so none of them is offered.
  const standing = useStanding();
  const [loading, setLoading] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [showWalkover, setShowWalkover] = useState(false);

  // Score submission state
  const isBO3 = format === 'bo3_21';
  const [games, setGames] = useState(
    isBO3
      // Scores are held as text, not numbers: with `parseInt(x) || 0` the field
      // snapped back to 0 the moment you cleared it, so you could never delete
      // the zero to type over it. Empty stays empty until submit.
      ? [{ game_number: 1, side_a_score: '', side_b_score: '' }, { game_number: 2, side_a_score: '', side_b_score: '' }, { game_number: 3, side_a_score: '', side_b_score: '' }]
      : [{ game_number: 1, side_a_score: '', side_b_score: '' }]
  );
  // Derived from the scores below rather than held in state — there is no
  // separate answer for the two to drift apart into.
  const tally = tallyGames(
    games.map((g) => ({ side_a_score: g.side_a_score, side_b_score: g.side_b_score })),
  );
  const derivedWinner = tally.winner;

  // Dispute state
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeCategory, setDisputeCategory] = useState('score_wrong');

  // THE OTHER SIDE OF THIS CHALLENGE, LIVE.
  //
  // This is the screen where the opponent is waiting: one player submits the
  // scoreline and the other has this page open, needing to be asked to confirm
  // it. revalidatePath covers the submitter, so before this the person being
  // asked had to reload to find out there was anything to answer.
  //
  // PARKED WHILE A DIALOG IS OPEN, which is the whole reason this call lives
  // in here rather than as a component on page.tsx. The three dialogs below
  // hold the only uncommitted input in this app that a refresh could disturb —
  // a half-typed scoreline (`games`, held as strings so a cleared field stays
  // cleared) and a half-written dispute reason. React does preserve that state
  // across router.refresh(), because Dialog is open-prop controlled and this
  // component keeps its identity; but the refresh would still re-render the
  // page underneath and can take away the very button the typing was heading
  // for, and the `standing.ok` early return below would unmount the lot. An
  // `enabled` flag is the answer the door list already uses for the same
  // problem: no dialog open, no socket, nothing to interrupt. Closing the
  // dialog re-subscribes and the next event catches up.
  //
  // The hook is called HERE, above the early return, because hooks must run
  // unconditionally — which also means a member in bad standing still gets a
  // live page even though they get no controls.
  useLiveMatches({
    channel: `challenge-${challengeId}`,
    challengeIds: [challengeId],
    enabled: !showSubmit && !showDispute && !showWalkover,
  });

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
        const res = await acceptChallenge(challengeId);
        if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
        toast('Challenge accepted!', 'success');
      } else if (action === 'reject') {
        const res = await rejectChallenge(challengeId);
        if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
        toast('Challenge rejected', 'info');
      } else if (action === 'confirm') {
        if (!matchId) return;
        const res = await confirmMatchResult(matchId);
        if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
        toast('Result confirmed! Elo updated.', 'success');
      } else if (action === 'cancel') {
        if (!(await confirm({ title: 'Cancel challenge?', message: 'Cancel this challenge? The opponent will be notified.', confirmLabel: 'Cancel challenge', danger: true }))) { setLoading(''); return; }
        const res = await cancelChallenge(challengeId);
        if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
        toast('Challenge cancelled', 'info');
      }
      // Deliberately no setLoading('') on the success path. router.refresh() is
      // async: clearing it here re-enabled the button while the page still
      // showed the old state, so a second click landed on a match that had
      // already been confirmed or disputed and failed with "Match not pending
      // confirmation". Every one of these actions changes the challenge state,
      // so the refresh re-renders this component and the button goes away on
      // its own.
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setLoading('');
    }
  }

  async function handleSubmitResult() {
    setLoading('submit');
    try {
      // A blank third game means the best-of-3 ended 2-0.
      const entered = games.filter((g, i) => !isBO3 || i < 2 || g.side_a_score !== '' || g.side_b_score !== '');
      const validGames = entered.map((g) => ({
        game_number: g.game_number,
        side_a_score: Number(g.side_a_score || 0),
        side_b_score: Number(g.side_b_score || 0),
      }));
      if (!derivedWinner) {
        toast('Enter the game scores — the winner is worked out from them.', 'error');
        setLoading('');
        return;
      }
      const res = await submitMatchResult(challengeId, {
        winner_side: derivedWinner,
        games: validGames,
        completed: true,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
      toast('Result submitted! Waiting for confirmation.', 'success');
      setShowSubmit(false);
      // Stays disabled until the refresh lands — see handleAction. A second
      // submit would hit "A match has already been submitted for this challenge".
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setLoading('');
    }
  }

  async function handleDispute() {
    if (!disputeReason.trim()) { toast('Reason required', 'error'); return; }
    if (!matchId) return;
    setLoading('dispute');
    try {
      const res = await disputeMatchResult(matchId, disputeReason, disputeCategory);
      if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
      toast('Dispute opened', 'info');
      setShowDispute(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setLoading('');
    }
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
      const res = await reportWalkover({
        challenge_id: challengeId,
        forfeit_player_id: forfeitPlayerId,
        walkover_type: type,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(''); return; }
      toast('Walkover reported. Admin will review.', 'info');
      setShowWalkover(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setLoading('');
    }
  }

  // The challenge itself, its participants and its result all stay on screen —
  // this only replaces the buttons, so the page reads as an account state
  // rather than as a challenge that has lost its actions.
  if (!standing.ok) {
    return (
      <div className="space-y-3">
        {(matchStatus === 'disputed' || challengeStatus === 'walkover_pending') && (
          <div className="card-base">
            <div className="card-title">
              {matchStatus === 'disputed' ? 'Result disputed' : 'Walkover reported'}
            </div>
            <div className="card-sub">
              An exec is reviewing this and will settle it. Ratings stay unchanged until they do.
            </div>
          </div>
        )}
        <div className="card-base">
          <div className="card-title">Actions paused</div>
          <div className="card-sub">{standing.detail}</div>
        </div>
      </div>
    );
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
          {/* Confirmation is the opponent's attestation — apply_match_result
              rejects "the submitter cannot confirm their own result", which is
              also what stops someone fabricating a match and confirming it
              themselves. Showing the button to the submitter only ever produced
              an error, so hide it. They keep the reporting route below, which is
              their only way to flag a score they mistyped. */}
          {!isSubmitter && (
            <Button onClick={() => handleAction('confirm')} loading={loading === 'confirm'} className="flex-1" variant="success">
              Confirm Result
            </Button>
          )}
          <Button onClick={() => setShowDispute(true)} variant="danger" className="flex-1">
            {isSubmitter ? 'Report an error' : 'Dispute'}
          </Button>
        </div>
      )}

      {/* Disputed and walkover-pending both wait on an exec, and neither had any
          branch here — the page rendered a red status tag and then stopped, with
          no action and nothing saying why. Say who holds it and what happens
          next, so a dead end reads as a queue rather than a broken screen. */}
      {(matchStatus === 'disputed' || challengeStatus === 'walkover_pending') && (
        <div className="card-base">
          <div className="card-title">
            {matchStatus === 'disputed' ? 'Result disputed' : 'Walkover reported'}
          </div>
          <div className="card-sub">
            An exec is reviewing this and will settle it. Ratings stay unchanged until they do —
            there is nothing else to do here.
          </div>
        </div>
      )}

      {/* Submit Result Dialog */}
      <Dialog open={showSubmit} onClose={() => setShowSubmit(false)} title="Submit Match Result">
        <div className="space-y-4">
          {/* Winner is derived from the scores below, not asked for. A
              dropdown beside the scores can disagree with them, and a
              mis-tapped winner on a correct scoreline produces a wrong rating
              change that nobody notices until the ladder looks odd. */}
          <div className="card-base" role="status" aria-live="polite">
            <div className="card-title">
              {derivedWinner
                ? `Winner: ${derivedWinner === 'a' ? labelA : labelB}`
                : 'Winner: enter the game scores'}
            </div>
            <div className="card-sub">
              {tally.aGamesWon}–{tally.bGamesWon} in games
              {derivedWinner ? '' : ' — tied or incomplete, so the result cannot be submitted yet'}
            </div>
          </div>
          {games.map((g, i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Input
                label={`Game ${g.game_number} — ${compactA}`}
                type="text"
                inputMode="numeric"
                value={g.side_a_score}
                onChange={(e) => {
                  const updated = [...games];
                  // Keep digits only; '' is allowed so the field can be cleared.
                  updated[i] = { ...g, side_a_score: e.target.value.replace(/\D/g, '') };
                  setGames(updated);
                }}
              />
              <Input
                label={`Game ${g.game_number} — ${compactB}`}
                type="text"
                inputMode="numeric"
                value={g.side_b_score}
                onChange={(e) => {
                  const updated = [...games];
                  // Keep digits only; '' is allowed so the field can be cleared.
                  updated[i] = { ...g, side_b_score: e.target.value.replace(/\D/g, '') };
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
      <Dialog open={showDispute} onClose={() => setShowDispute(false)} title={isSubmitter ? 'Report an error in your result' : 'Dispute Result'}>
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
