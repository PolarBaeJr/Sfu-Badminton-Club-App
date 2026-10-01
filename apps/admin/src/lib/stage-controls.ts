// What the Draw / Redraw button on a stage says, and why it is greyed. The
// server (drawStageImpl, publish_stage_draw) decides; this only tells the exec
// before the click rather than after.

import { summariseRedrawBlockers, type TournamentEventStatus } from '@badminton/shared';

export interface StageDrawState {
  /** 1-based. */
  number: number;
  name: string;
  drawn: boolean;
  ready: boolean;
  waitingOn: string[];
}

export interface StageDrawControl {
  action: 'draw' | 'redraw';
  /** null when the button can be pressed. */
  blockedReason: string | null;
}

type BlockerRow = Parameters<typeof summariseRedrawBlockers>[0][number];

export function stageDrawControl(
  stage: StageDrawState,
  ctx: {
    status: TournamentEventStatus;
    drawLocked: boolean;
    canGenerate: boolean;
    /** A stage after this one has matches. */
    laterDrawn: boolean;
    /** This stage's own match rows. */
    rows: readonly BlockerRow[];
  },
): StageDrawControl {
  const action = stage.drawn ? 'redraw' : 'draw';
  const blocked = (blockedReason: string): StageDrawControl => ({ action, blockedReason });
  if (!ctx.canGenerate) return blocked('You do not have permission to draw this event.');
  if (ctx.status === 'completed') return blocked('This event has been finalised.');
  if (ctx.drawLocked) return blocked('The draw is locked. Unlock it first.');
  if (ctx.status === 'registration') return blocked('Open check-in first.');
  if (stage.drawn) {
    if (ctx.laterDrawn) return blocked('A later stage has been drawn from this one.');
    const b = summariseRedrawBlockers([...ctx.rows]);
    if (b.played > 0) return blocked(`${b.played} match${b.played === 1 ? ' has' : 'es have'} a result. Void or undo ${b.played === 1 ? 'it' : 'them'} first.`);
    if (b.rated > 0) return blocked(`${b.rated} match${b.rated === 1 ? ' still carries' : 'es still carry'} an applied rating.`);
    if (b.inProgress > 0) return blocked(`${b.inProgress} match${b.inProgress === 1 ? ' is' : 'es are'} on court right now.`);
    return { action, blockedReason: null };
  }
  if (stage.number > 1 && ctx.status !== 'live') return blocked('Start the event before drawing a later stage.');
  if (!stage.ready) {
    return blocked(stage.waitingOn.length > 0
      ? `Waiting on ${stage.waitingOn.join(' and ')} to finish.`
      : 'An earlier stage has to be drawn and played first.');
  }
  return { action, blockedReason: null };
}

/**
 * The warning beside Draw on a stage that plays with head starts: teams still
 * in the event with no category start every game on 0. It warns, it does not
 * block: an organiser may mean it.
 */
export function uncategorisedWarning(
  pairs: ReadonlyArray<{ status: string; team_category?: string | null }>,
): string | null {
  const n = pairs.filter((p) => p.status !== 'withdrawn' && p.status !== 'disqualified' && p.team_category == null).length;
  if (n === 0) return null;
  return n === 1
    ? '1 team has no category, so it gets no head start. Set it in Participants.'
    : `${n} teams have no category, so they get no head start. Set it in Participants.`;
}
