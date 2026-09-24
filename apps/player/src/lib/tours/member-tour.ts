// THE MEMBER TOUR, as data. Its own module with no framework import so a test
// can read it: the host component (components/member-tour-host.tsx) pulls in
// next/navigation.
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
import type { TourStep } from '@badminton/ui/src/tour';
import type { TourKey } from '@badminton/shared/src/utils/tours';

export const MEMBER_TOUR_KEY: TourKey = 'member_v1';

export const MEMBER_TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to the club app',
    body: 'A quick look at where things are. It takes about a minute, and you can skip it at any point.',
    targets: [],
    missingTarget: 'center',
  },
  {
    id: 'calendar',
    title: 'Your week, or your month',
    body: 'Everything the club has on: sessions, club events and tournaments. Tap a day to jump to it.',
    targets: ['[data-tour="week-strip"]', '[data-tour="month-calendar"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['sessions', 'events', 'tournaments'] },
  },
  {
    id: 'next-session',
    title: 'RSVP and check in',
    body: "Tap Going or Can't make it on each session so the club knows who is coming. Check-in opens shortly before a session starts: check in here, or scan the QR code at the door.",
    targets: ['[data-tour="next-session"]', '[data-tour="up-next"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['sessions'], approved: true },
  },
  {
    id: 'calendar-subscribe',
    title: 'Add it to your calendar',
    body: 'Put the whole schedule in the calendar app on your phone. It stays up to date by itself, and the feed link lives in Settings too.',
    targets: ['[data-tour="calendar-subscribe"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['sessions', 'events'] },
  },
  {
    id: 'activity',
    title: 'Club activity',
    body: 'Announcements from the exec, and results from around the club as they are confirmed.',
    targets: ['[data-tour="activity"]'],
    missingTarget: 'skip',
  },
  {
    id: 'challenges',
    title: 'Challenges',
    body: 'Challenge another member to a rated match, then report the score together once you have played.',
    targets: ['.topbar [data-tour-nav="/challenges"]', '.mobile-tabbar [data-tour-nav="/challenges"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['challenges'], approved: true },
  },
  {
    id: 'ranks',
    title: 'Ranks and Elo',
    body: 'Every rated match moves your Elo. The ladder shows where you stand in singles and in doubles.',
    targets: ['.mobile-tabbar [data-tour-nav="/leaderboard"]', '.topbar [data-nav-group="stats"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['leaderboard'] },
  },
  {
    id: 'events',
    title: 'Events',
    body: 'Tournaments and club events: socials, workshops, clinics and the AGM. Sign up from their pages.',
    targets: ['.mobile-tabbar [data-tour-nav="group:events"]', '.topbar [data-nav-group="events"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['tournaments', 'events'], approved: true },
  },
  {
    id: 'you',
    title: 'You',
    body: 'Your attendance streak, your ratings and your full stats.',
    targets: ['.mobile-tabbar [data-tour-nav="/my-stats"]', '[data-tour="you-card"]'],
    missingTarget: 'skip',
    requires: { featuresAny: ['my_stats'] },
  },
  {
    id: 'settings',
    title: 'Settings',
    body: 'Notifications stay off until you turn them on here. Add a passkey to sign in without an emailed code, grab the calendar feed, and link Discord by running /link in the club Discord at discord.sfubadminton.com.',
    targets: ['[data-tour="settings-chip"]'],
    missingTarget: 'center',
  },
  {
    id: 'done',
    title: 'That is everything',
    body: 'Replay this tour any time from Settings.',
    targets: [],
    missingTarget: 'center',
  },
];
