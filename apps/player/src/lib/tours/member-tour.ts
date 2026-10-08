// THE MEMBER TOUR, as data. Its own module with no framework import so a test
// can read it: the host component (components/member-tour-host.tsx) pulls in
// next/navigation.
//
// SIX STEPS, under 110 words, under a minute. Setup plus this tour must fit
// in 3 minutes on a phone (onboarding-budget.test.ts), so a new step has to
// replace one. Challenges have their own stop because they are what the club
// is for; events and tournaments are covered by the feed's calendar, which is
// where members meet them. The steps are built from the reader's context
// because the membership step depends on two switches.
//
// STEPS VISIT PAGES. A step's href is the page it is shown on, and the tour
// opens it through the router; a step with none stays on the page before it,
// so the welcome card is on the feed, where the tour starts.
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
import { requirementsMet, type TourContext, type TourStep } from '@badminton/ui/src/tour';
import type { TourKey } from '@badminton/shared/src/utils/tours';

export const MEMBER_TOUR_KEY: TourKey = 'member_v2';

const SETTINGS_APPROVED =
  'Notifications stay off until you turn them on here. Also here: Membership, the calendar feed, passkeys, the tour replay. Link Discord with /link at discord.example.com.';
const SETTINGS_PENDING =
  'Notifications stay off until you turn them on here. Also here: passkeys and a tour replay. Link Discord with /link at discord.example.com.';

export function memberTourSteps(ctx: TourContext): TourStep[] {
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
      body: 'Sessions, club events and tournaments all show up here. Tap a day to jump to it.',
      href: '/feed',
      targets: ['[data-tour="week-strip"]', '[data-tour="month-calendar"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions', 'events', 'tournaments'] },
    },
    {
      id: 'next-session',
      title: 'RSVP and check in',
      body: "Tap Going or Can't make it. Check-in opens shortly before it starts: check in here, or scan the QR code at the door.",
      href: '/feed',
      targets: ['[data-tour="next-session"]', '[data-tour="up-next"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], approved: true },
    },
  ];
  // Challenges are the point of the club, so they get their own stop rather
  // than a line in a list. The button is absent when the member's open
  // challenges are at the cap; the card then sits centred on the page.
  steps.push({
    id: 'challenges',
    title: 'Challenge someone',
    body: 'Challenge any member to a rated match: tap New challenge and pick who. The result moves both players\' ratings.',
    href: '/challenges',
    targets: ['[data-tour="new-challenge"]'],
    missingTarget: 'center',
    requires: { featuresAny: ['challenges'], approved: true },
  });
  // Only where the statement is: an approved member, with both the fees and
  // the membership switches on (membership/page.tsx). requires cannot say
  // "both", so the membership half is checked here. A card if the statement
  // is not there to point at.
  if (requirementsMet({ featuresAny: ['membership'] }, ctx)) {
    steps.push({
      id: 'membership',
      title: 'Membership and fees',
      body: 'Pay dues by e-transfer or the Campus Rec site, then send the receipt here.',
      href: '/membership',
      targets: ['[data-tour="membership-statement"]'],
      missingTarget: 'center',
      requires: { featuresAny: ['fees'], approved: true },
    });
  }
  steps.push({
    id: 'settings',
    title: 'Settings',
    body: ctx.approved ? SETTINGS_APPROVED : SETTINGS_PENDING,
    href: '/settings',
    targets: ['[data-tour="settings-notifications"]'],
    missingTarget: 'center',
  });
  return steps;
}
