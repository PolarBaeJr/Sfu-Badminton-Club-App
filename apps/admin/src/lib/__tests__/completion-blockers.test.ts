import { describe, it, expect } from 'vitest';
import {
  describeCompletionBlockers,
  REMEDY_ARCHIVE,
  REMEDY_COMPLETE,
  type EventCompletionBlocker,
} from '../tournament-actions/completion-blockers';

function blocker(over: Partial<EventCompletionBlocker> = {}): EventCompletionBlocker {
  return {
    id: 'e1',
    label: "Men's Singles",
    status: 'live',
    statusLabel: 'Live',
    bucket: 'finalisable',
    incomplete: 7,
    matchCount: 12,
    ...over,
  };
}

describe('the refusal names the control on the screen the exec is looking at', () => {
  // THE BUG THIS PINS. Observed on staging 2026-08-18: pressing Archive on a
  // dirty tournament from the list refused correctly, but told the exec to use
  // "Finalise events & complete" — a control that exists only on the tournament
  // detail page. The list's own control says "& archive". Sending someone to a
  // button that is not on their screen reads as a missing feature.
  it('names the archive control when the caller is archiving', () => {
    const msg = describeCompletionBlockers([blocker()], REMEDY_ARCHIVE);
    expect(msg).toContain('"Finalise events & archive"');
    expect(msg).not.toContain('& complete');
  });

  it('names the complete control when the caller is completing', () => {
    const msg = describeCompletionBlockers([blocker()], REMEDY_COMPLETE);
    expect(msg).toContain('"Finalise events & complete"');
    expect(msg).not.toContain('& archive');
  });
});

describe('what the refusal actually tells them', () => {
  it('names every blocking event rather than counting them', () => {
    const msg = describeCompletionBlockers(
      [
        blocker({ id: 'a', label: "Men's Singles", statusLabel: 'Live', incomplete: 7 }),
        blocker({ id: 'b', label: "Women's Singles", statusLabel: 'Bracket Generated', incomplete: 8 }),
      ],
      REMEDY_ARCHIVE,
    );
    expect(msg).toContain("Men's Singles (Live, 7 unplayed)");
    expect(msg).toContain("Women's Singles (Bracket Generated, 8 unplayed)");
    expect(msg).toContain('2 events have not finished');
  });

  it('drops the unplayed count when there is none to report', () => {
    const msg = describeCompletionBlockers(
      [blocker({ statusLabel: 'Check-in', incomplete: 0 })],
      REMEDY_ARCHIVE,
    );
    expect(msg).toContain("Men's Singles (Check-in)");
    expect(msg).not.toContain('unplayed');
  });

  it('agrees in number for a single blocker', () => {
    const msg = describeCompletionBlockers([blocker()], REMEDY_ARCHIVE);
    expect(msg).toContain('1 event has not finished');
  });
});
