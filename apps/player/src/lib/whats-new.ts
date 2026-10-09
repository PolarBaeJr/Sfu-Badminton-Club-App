// THE MEMBERS' RELEASE NOTES, shown at /whats-new.
//
// Newest first, one entry per version that shipped, written for members rather
// than for whoever deployed it. A version that never shipped (1.0.9) is not
// listed. `execs` is for changes only the console shows.

export type WhatsNewEntry = {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  members: string[];
  execs?: string[];
};

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.1.0',
    date: '2026-10-08',
    title: 'Membership, receipts and club events',
    members: [
      "A public Membership page shows this season's prices and how to buy a membership, and your fee statement now lives there.",
      'Send a receipt for your fees: a screenshot of your e-Transfer or SFU Rec purchase.',
      'Sign in with a password if you like. Email codes and passkeys still work, and Settings can sign out your other devices.',
      'Sign-in and sign-up are separate pages, and account setup asks one question per screen.',
      'The Feed is the home page: a week strip, the month calendar and Up next for the coming two weeks.',
      'Club events: socials, workshops, clinics, outings and the AGM, with their own sign-up.',
      'A short tour on your first visit. Replay it from Settings.',
      'Challenges are redesigned, and best of 5 and best of 7 results can be reported in full.',
      'Challenge, report a result or join the club from Discord.',
      'Choose whether the club may use photos and videos of you, in Settings.',
      'A Discord link on every page, and a Socials page.',
      'Error screens show a short code to quote when you report a problem.',
      'This page: a list of what changed in each version, under Settings > About.',
      'Joining from Discord asks for your SFU email if you have one.',
    ],
    execs: [
      'Fee tools: receipt review, Paste a list, and named payments that follow a member who signs up later.',
      'Switch member pages on or off under Accounts.',
      'Audit trail download, and the top bar grouped into menus.',
      "A Member app link in the console's top bar takes you back to the members' site.",
      "The audit log's search, filters and download sit in two tidy rows, and the activity chart is gone.",
      'The four Legal pages are one Legal entry in the Club menu, which opens to show them.',
      'The Data API has a public changelog page.',
      'A Data API key can be minted with no expiry, and its date uses the club calendar.',
      'The Accounts side menu follows the section you are reading.',
    ],
  },
  {
    version: '1.0.8',
    date: '2026-09-29',
    title: 'Court desk search',
    members: [],
    execs: [
      'Search the court desk, and check-in times shown in club time.',
    ],
  },
  {
    version: '1.0.7',
    date: '2026-09-29',
    title: 'Tournament fixes',
    members: [
      "A tournament's start date shows the right day, and pairs are called pairs.",
    ],
    execs: [
      'Undo a check-in or a no-show.',
    ],
  },
  {
    version: '1.0.6',
    date: '2026-09-28',
    title: 'My stats by season',
    members: [
      'Every card on My stats now follows the season you pick.',
    ],
  },
  {
    version: '1.0.5',
    date: '2026-09-27',
    title: 'Passkey fixes',
    members: [
      "If a passkey cannot work inside an app's built-in browser, the page now says so.",
      'On iPhone, one tap opens the passkey sheet.',
      'A fresh sign-in code is no longer reported as expired.',
    ],
  },
  {
    version: '1.0.4',
    date: '2026-09-22',
    title: 'Your data',
    members: [
      'Download everything the club holds about you, from Settings.',
      'The legal documents name the club and how to reach it.',
    ],
  },
  {
    version: '1.0.3',
    date: '2026-09-19',
    title: 'Handles and final standings',
    members: [
      'Every member has a handle.',
      'The leaderboard shows final standings for a finished season and marks your own row.',
      'Rounded corners across the app.',
    ],
  },
  {
    version: '1.0.2',
    date: '2026-09-18',
    title: 'Tidying up',
    members: [
      'Unfinished sign-ups are cleared after 30 days.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-09-17',
    title: 'First fixes',
    members: [
      'Dates more than a week away show in club time.',
      'Tournament points are no longer labelled Provisional.',
      'The app no longer names the current season when you are looking at a past one.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-13',
    title: 'Launch',
    members: [
      'The SFU Badminton Club app: sessions, the ladder, challenges, tournaments and your stats in one place.',
    ],
  },
];
