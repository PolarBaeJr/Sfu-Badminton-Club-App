# 2 · What's Been Built (Complete List)

*Everything that exists and works today, grouped by area. This is the exhaustive version — including the small fixes and polish. Nothing here is "planned"; it's all live.*

---

## 🪜 The ladder & rating system

- **Dual ELO ratings** — every player has a **separate singles rating and doubles rating**, so being a great singles player doesn't inflate your doubles rank and vice versa.
- **Sensible starting point & spread** — everyone starts at **400**; the top of the club sits around **1300**. Ratings are capped to a safe range so no one can run away to absurd numbers or crash to zero.
- **Placement period** — new players are marked **"provisional"** for their first **8 matches** in each format. During placement their rating moves faster so they find their true level quickly, then it settles.
- **Streaks & detailed stats** — the system tracks current and best win streaks, wins/losses, points scored and allowed, and games won/lost — all split by singles and doubles.
- **Match importance weighting** — tournament and higher-stakes matches move ratings more than casual games, so the ranking reflects real competition.
- **Consistent everywhere** — the exact same rating math runs in the app and in the database, so numbers never disagree between screens.

## 📅 Seasons & fees

- **Seasons backbone** — the club runs in seasons. One season is "active" at a time, and everything (sessions, fees) attaches to it.
- **Season reset policy** — at the end of a season, admins choose how ratings carry over: **keep them**, **softly compress toward the middle**, or **full reset** — with a confirmation step so it's never accidental.
- **Season archive** — final ratings and standings are **snapshotted** at each season's end, so past seasons are preserved for records and awards.
- **Fees follow the season** — each season has its own competitive and recreational fee amounts. Fees are tracked per member, and members can be marked **fee-exempt** where appropriate.

## 🏸 Sessions & attendance

- **Session scheduling** — admins/execs create sessions with a date, venue, and **track** (competitive, recreational, or all).
- **Player check-in** — members check themselves in to sessions from their phone.
- **Attendance rosters** — execs/admins see exactly who checked in to each session, with live counts.
- **Add to calendar** — players can add a session to their personal calendar (Apple/Google) in one tap.
- **Automatic reminders** — the app sends session reminders so people don't forget to show up.

## 🏆 Tournaments

A full tournament system, not just a bracket generator:

- **Lifecycle management** — tournaments move through clear stages (draft → active → completed → archived).
- **Multiple events per tournament** — each event (e.g. Men's Singles, Mixed Doubles) has its own phases: registration → check-in → bracket → live → completed.
- **Registration & check-in** — players register and check in on event day; admins can also check people in, including bulk check-in.
- **Singles and doubles** — full support for both, including doubles pairs.
- **Automatic seeding** — brackets are seeded by ELO so the strongest players don't meet in round one.
- **Bracket generation, results entry, and finalization** — including **placement bonuses** applied to ratings when an event finishes.
- **Participant states** — registered, checked-in, withdrawn, disqualified, no-show — all tracked.
- **Change history** — tournament actions are logged for accountability.

## ⚔️ Challenges, matches, disputes

- **Challenge flow** — a player issues a challenge, the opponent accepts, they play, and the result is reported and confirmed. Ratings update on confirmation.
- **Challenge expiry** — unanswered challenges expire automatically so they don't linger.
- **Full match records** — every match stores each player's rating before and after, the point-by-point game scores, and the rating change.
- **Head-to-head & partnership records** — the system tracks how any two players stack up against each other, and how doubles partnerships perform together.
- **Disputes & walkovers** — a proper process for contested results and no-shows, plus a **reliability** signal so flaky players are visible.

## 🌐 Public pages

- **Landing page** — a public homepage showing the live top of the ladder (great for recruitment).
- **Public leaderboard** — the full ranking, viewable without logging in (hiding anyone who opts out or isn't approved).
- **Executive page** — a public roster of the current exec team with titles.

## 🛠️ Admin console & finance

- **Role-filtered navigation** — the console shows execs the club-management tools and reserves finance/member tools for admins.
- **Member management** — admins manage player records, roles, and exec status.
- **Finance / income tracking** — the admin side tracks club income.
- **Announcements** — post announcements to the membership.

## 🔔 Notifications

- **Email** — branded club emails (login codes, reminders, announcements) via a professional email service.
- **Push notifications** — the installed app can send push notifications to phones.
- **Automated background jobs** — the system automatically expires old challenges, sends challenge/session reminders, chases up unconfirmed results, flags no-show patterns, marks inactive players, and captures season snapshots — all without anyone pressing a button.

## 📝 Feedback

- **Event & tournament feedback forms** — collect feedback after events.

## 📱 Installable app (PWA)

- The website can be **installed to a phone's home screen** and behaves like a native app, with its own icon and a fast, app-like feel — no app store required.

## 🎨 Design & polish (the details)

- **Professional design system** — a consistent set of ~two dozen reusable interface pieces gives every screen the same polished look.
- **Light and dark mode** — full support for both; the app remembers your choice and even loads in the right theme instantly (no flash of the wrong colors).
- **Club branding** — a custom shuttlecock logo throughout.
- **Modern, scanner-safe login** — a **6-digit code** login that reliably works even when corporate/email security tools "click" links in emails (a common bug that breaks normal magic-link logins). Plus one-tap **Google sign-in**.
- **Small fixes that add up:**
  - Login screen redesigned; app navigation hidden on login/sign-up screens for a clean first impression.
  - Fixed a **mobile layout bug** where a page could be wider than the phone screen and let people accidentally pinch-zoom.
  - Fixed a spotlight card that stayed dark in light mode.
  - Corrected the venue name (Lorne Davies Complex).
  - Fixed notification pop-ups and status badges that rendered incorrectly.
  - Phone-number inputs now clean up what you type automatically.
  - Fees can add a new term directly from the dropdown.

---

## How it got here — build timeline

The app has been through several deliberate phases:

1. **Initial build** — the original club app (ladder, basic management).
2. **Security & cleanup overhaul** — a large pass fixing security issues and adding win/loss stats, push notifications, the installable-app features, and fee tracking.
3. **Self-hosting migration** — moved onto the club's own infrastructure with proper, private security keys (this closed a serious hole — see the security doc), plus automatic backups.
4. **Seasons / fees / roles rework** — the big structural upgrade: the seasons system, fees-follow-seasons, executive access levels, the rating rescale and reset policy, the public pages, and finance tracking.
5. **Polish & design** — the professional redesign, dark mode, login redesign, and the mobile/visual fixes above.
6. **Executive beta (now)** — private testing with the exec team, July 2026.

➡️ Continue to **[03-roadmap.md](03-roadmap.md)** for what's coming next.
