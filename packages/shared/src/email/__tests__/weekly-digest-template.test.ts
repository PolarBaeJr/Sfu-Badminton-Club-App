// THE ONE MAIL A MEMBER GETS WITHOUT ASKING FOR IT, and the only place a
// suppressed Elo figure becomes something a person reads.
//
// The caller withholds both Elo figures on a week when a season rolled over,
// because a rollover on a soft or full policy rewrites every rating without
// emitting a rating_delta (see the weekly-digest route). This file is about
// what that looks like in the inbox: the subject line carries the Elo figure,
// so on those weeks it loses its number, and a recap that quietly drops three
// figures reads as a broken send unless something in it says otherwise.

import { describe, it, expect } from 'vitest';
import { weeklyDigestEmail } from '../templates';

const URL = 'https://player.example/my-stats';
const week = (over: Partial<Parameters<typeof weeklyDigestEmail>[1]> = {}) =>
  weeklyDigestEmail(
    'Member',
    { matchesPlayed: 3, wins: 2, losses: 1, eloChange: 12, singlesRating: 1100, doublesRating: null, ...over },
    URL,
  );

describe('the weekly recap subject line', () => {
  it('carries the net Elo, signed', () => {
    expect(week().subject).toContain('+12 Elo');
    expect(week({ eloChange: -8 }).subject).toContain('-8 Elo');
  });

  it('drops the figure, not the mail, when there is no figure to give', () => {
    const { subject } = week({ eloChange: null });
    expect(subject).toBe('Your weekly recap');
    expect(subject).not.toContain('Elo');
    // Never the string 'null', which is the failure this replaces in kind: a
    // template that interpolates a withheld value straight into the subject.
    expect(subject).not.toContain('null');
  });
});

describe('the weekly recap body across a rollover', () => {
  it('says why the ratings are missing, before they are missed', () => {
    const { html } = week({ eloChange: null, singlesRating: null, doublesRating: null });
    expect(html).toContain('A new season started this week');
    // Ahead of the figures that survived, so the absence is explained rather
    // than discovered. Compared by index because the reader reads in order.
    expect(html.indexOf('A new season started')).toBeLessThan(html.indexOf('Matches Played'));
  });

  it('drops the Net Elo line rather than printing an empty one', () => {
    const { html } = week({ eloChange: null, singlesRating: null, doublesRating: null });
    expect(html).not.toContain('Net Elo');
    expect(html).not.toContain('null');
    // What a rebase does not invalidate still goes out.
    expect(html).toContain('Matches Played: <strong>3</strong>');
    expect(html).toContain('2W - 1L');
  });

  it('keeps a genuine zero, which is a result and not a suppression', () => {
    // A member who played and came out level moved by 0. That is a fact about
    // their week, and collapsing it into the withheld case would tell them a
    // season had rolled over when none had.
    const { subject, html } = week({ eloChange: 0 });
    expect(subject).toContain('+0 Elo');
    expect(html).toContain('Net Elo');
    expect(html).not.toContain('A new season started');
  });

  it('says nothing about a season on an ordinary week', () => {
    expect(week().html).not.toContain('A new season started');
  });
});
