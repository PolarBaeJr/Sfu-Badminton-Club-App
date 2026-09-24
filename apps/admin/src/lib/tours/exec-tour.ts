// THE EXEC TOUR, as data. Its own module with no framework import so a test
// can read it: the host component (components/exec-tour-host.tsx) pulls in
// next/navigation.
//
// ONE PAGE. The tour never navigates: every step points at something in the
// top bar (a nav group's trigger, or the Settings link) and says where to find
// the thing inside it, "Open Play, then Sessions". The dashboard's pending
// approvals panel is the one exception, and it falls back to the Members group
// when the tour is running on another page.
//
// Each step names the capability that makes it true for the reader. What an
// officer holds varies with their role and grants (access-level.ts), so an
// officer who cannot approve signups is never told how to. Two steps also have
// a sentence that depends on a second capability (bulk session edits, the
// Discord cross-post), which is why the steps are built from what the reader
// holds rather than declared once.
//
// Deep imports, not the package barrels: a test loads this file.
import type { TourStep } from '@badminton/ui/src/tour';
import type { TourKey } from '@badminton/shared/src/utils/tours';

export const EXEC_TOUR_KEY: TourKey = 'exec_v1';

/**
 * Whether the tour may open by itself for this level. Never for a trainer,
 * whose console is the roster and varsity notes, and never before the level is
 * known. A replay from Settings is allowed for anybody.
 */
export function execTourMayAutoStart(level: string | null): boolean {
  return level !== null && level !== 'trainer';
}

export function execTourSteps(held: ReadonlySet<string>): TourStep[] {
  const canBulkSessions = held.has('sessions.create.write') || held.has('sessions.update.write');
  const canIssueQr = held.has('sessions.checkin.token.write');
  const canPostToDiscord = held.has('announcements.discord.write');

  return [
    {
      id: 'welcome',
      title: 'Welcome to the console',
      body: 'A short look at where the club is run from. What you see depends on what you have been given, so some of this may not apply to you yet.',
      targets: [],
      missingTarget: 'center',
    },
    {
      id: 'pending-approvals',
      title: 'Pending approvals',
      body: 'New signups waiting for an exec land on the dashboard, and you approve them there. Open Members, then Players, to see everyone.',
      targets: ['[data-tour="pending-approvals"]', '[data-nav-group="members"]'],
      missingTarget: 'skip',
      requires: { capabilitiesAll: ['players.approve.write'] },
    },
    {
      id: 'sessions',
      title: 'Sessions',
      body: canBulkSessions
        ? 'The club schedule. Create a session, or select several and edit, archive or delete them together. Open Play, then Sessions.'
        : 'The club schedule, and who is coming to each night. Open Play, then Sessions.',
      targets: ['[data-nav-group="play"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], capabilitiesAll: ['sessions.page'] },
    },
    {
      id: 'door',
      title: 'The door list',
      body: canIssueQr
        ? "Tonight's door list shows who is signed up and who has checked in. Check-in QR puts up the code members scan at the door. Open Play, then Sessions."
        : "Tonight's door list shows who is signed up and who has checked in. Showing the check-in QR code needs a permission an admin can grant. Open Play, then Sessions.",
      targets: ['[data-nav-group="play"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], capabilitiesAll: ['sessions.page'] },
    },
    {
      id: 'members',
      title: 'Members',
      body: 'Every member of the club, their standing and their approval. Open Members, then Players.',
      targets: ['[data-nav-group="members"]'],
      missingTarget: 'skip',
      requires: { capabilitiesAll: ['players.page'] },
    },
    {
      id: 'club-events',
      title: 'Club events',
      body: 'Socials, workshops, clinics and the AGM, and who has signed up. Open Events, then Club events.',
      targets: ['[data-nav-group="events"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['events'], capabilitiesAll: ['events.page'] },
    },
    {
      id: 'announcements',
      title: 'Announcements',
      body: canPostToDiscord
        ? 'Post news to the members app, and send it to the club Discord at the same time. Open Club, then Announcements.'
        : 'Post news to the members app. Open Club, then Announcements.',
      targets: ['[data-nav-group="club"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['announcements'], capabilitiesAll: ['announcements.page'] },
    },
    {
      id: 'feature-switches',
      title: 'Feature switches',
      body: 'Switch whole parts of the members app on or off, such as challenges or tournaments. Open Members, then Accounts.',
      targets: ['[data-nav-group="members"]'],
      missingTarget: 'skip',
      requires: { capabilitiesAll: ['accounts.page', 'platform.settings.write'] },
    },
    {
      id: 'settings',
      title: 'Settings',
      body: 'Add a passkey to sign in to the console, and replay this tour. Open Settings.',
      targets: ['header a[href$="/settings"]'],
      missingTarget: 'center',
    },
    {
      id: 'done',
      title: 'That is the tour',
      body: 'Replay it any time from Settings.',
      targets: [],
      missingTarget: 'center',
    },
  ];
}
