// THE MEMBER TOUR, as data. Its own module with no framework import so a test
// can read it: the host component (components/member-tour-host.tsx) pulls in
// next/navigation.
//
// SIX STEPS, under 110 words, under a minute. Setup plus this tour must fit
// in 3 minutes on a phone (onboarding-budget.test.ts), so a new step has to
// replace one. The tabs step is one card for every tab, and its body is built
// from the features this member can see, which is why the steps are built from
// the reader's context rather than declared once.
//
// Targets are listed in priority order and the first VISIBLE one wins. That is
// how a step points at the tab bar on a phone and the top bar on a desktop:
// both are always in the DOM, only one is on screen, and the layout's
// breakpoints (760, 980, 1100) never have to be repeated here.
//
// A step whose feature is switched off is left out (requires.featuresAny), and
// so is one a pending signup cannot use yet (requires.approved). A step with
// nothing on screen to point at is skipped, except the ones marked 'center',
// which are cards and need no target.
//
// Deep imports, not the package barrels: a test loads this file.
import { requirementsMet, type TourContext, type TourStep, type TourStepRequires } from '@badminton/ui/src/tour';
import type { TourKey } from '@badminton/shared/src/utils/tours';

export const MEMBER_TOUR_KEY: TourKey = 'member_v1';

const TAB_LINES: readonly { text: string; requires: TourStepRequires }[] = [
  {
    text: 'Challenges: play a rated match against another member.',
    requires: { featuresAny: ['challenges'], approved: true },
  },
  {
    text: 'Ranks: your singles and doubles ladder.',
    requires: { featuresAny: ['leaderboard'] },
  },
  {
    text: 'Events: see what is on and sign up.',
    requires: { featuresAny: ['tournaments', 'events'], approved: true },
  },
];

const SETTINGS_APPROVED =
  'Notifications stay off until you turn them on here. Also here: Membership, the calendar feed, passkeys, the tour replay. Link Discord with /link at discord.sfubadminton.com.';
const SETTINGS_PENDING =
  'Notifications stay off until you turn them on here. Also here: passkeys and a tour replay. Link Discord with /link at discord.sfubadminton.com.';

export function memberTourSteps(ctx: TourContext): TourStep[] {
  const tabs = TAB_LINES.filter((line) => requirementsMet(line.requires, ctx))
    .map((line) => line.text)
    .join(' ');

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Welcome to the club app',
      body: 'A quick look around the app. It takes under a minute.',
      targets: [],
      missingTarget: 'center',
    },
    {
      id: 'calendar',
      title: 'Your schedule',
      body: 'Everything the club has on. Tap a day to jump to it.',
      targets: ['[data-tour="week-strip"]', '[data-tour="month-calendar"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions', 'events', 'tournaments'] },
    },
    {
      id: 'next-session',
      title: 'RSVP and check in',
      body: "Tap Going or Can't make it. Check-in opens shortly before it starts: check in here, or scan the QR code at the door.",
      targets: ['[data-tour="next-session"]', '[data-tour="up-next"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], approved: true },
    },
  ];
  if (tabs) {
    steps.push({
      id: 'tabs',
      title: 'The rest of the club',
      body: tabs,
      targets: ['[data-tour="tab-bar"]', '[data-tour="top-nav"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['challenges', 'leaderboard', 'tournaments', 'events'] },
    });
  }
  // Only where the statement is: an approved member, with both the fees and
  // the membership switches on (membership/page.tsx). requires cannot say
  // "both", so the membership half is checked here. On a phone there is no
  // Membership tab, so the step is a card.
  if (requirementsMet({ featuresAny: ['membership'] }, ctx)) {
    steps.push({
      id: 'membership',
      title: 'Membership and fees',
      body: 'Pay dues by e-transfer or the SFU Rec site, then upload the receipt on Membership.',
      targets: ['[data-tour="membership-link"]'],
      missingTarget: 'center',
      requires: { featuresAny: ['fees'], approved: true },
    });
  }
  steps.push({
    id: 'settings',
    title: 'Settings',
    body: ctx.approved ? SETTINGS_APPROVED : SETTINGS_PENDING,
    targets: ['[data-tour="settings-chip"]'],
    missingTarget: 'center',
  });
  return steps;
}
