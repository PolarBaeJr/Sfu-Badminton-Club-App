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
- **Attendance marking** — execs/admins can mark anyone **present, no-show, or excused** (and add walk-ins who never self-checked-in). Every mark is audit-logged, and no-shows don't inflate the "attending" count players see.
- **Real session times & check-in windows** — sessions now store an actual start (and optional end) time, and self check-in closes when the session ends — enforced in the database, not just the app. How early check-in opens is a club setting (currently: any time in advance, so it still works as an RSVP).
- **Session RSVP** — ahead of time, members tap **"Going" / "Can't make it"** on the Schedule page, separate from same-day check-in. The schedule shows a live **"N going"** count, and admins see the actual **going / declined name lists** per session.
- **Add to calendar (one-tap)** — players can add a single session to their personal calendar (Apple/Google) in one tap.
- **Subscribed calendar feed** — members can also **subscribe** their calendar (webcal/ICS) so sessions appear and stay in sync automatically. Each player has a private, unguessable feed link (resettable from Settings, which instantly revokes the old link); events deep-link back to the session in the app.
- **Automatic reminders** — the app sends session reminders so people don't forget to show up.

## 🏆 Tournaments

A full tournament system, not just a bracket generator:

- **Lifecycle management** — tournaments move through clear stages (draft → active → completed → archived).
- **Multiple events per tournament** — each event (e.g. Men's Singles, Mixed Doubles) has its own phases: registration → check-in → bracket → live → completed.
- **Registration & check-in** — players register and check in on event day; admins can also check people in, including bulk check-in.
- **Singles and doubles** — full support for both, including doubles pairs.
- **Automatic seeding** — brackets are seeded by ELO so the strongest players don't meet in round one.
- **Bracket generation, results entry, and finalization** — including **placement bonuses** applied to ratings when an event finishes.
- **Tournament suspension** — admins/execs can **pause a tournament with a reason** (weather, venue issues) and resume it cleanly. While paused: no registration, check-in, bracket generation, or score entry; players see a clear "suspended" notice everywhere. Corrections and withdrawals still work, and completing or archiving lifts the suspension automatically.
- **Participant states** — registered, checked-in, withdrawn, disqualified, no-show — all tracked.
- **Change history** — tournament actions are logged for accountability.

## ⚖️ Safety & compliance

- **Four legal documents** — members accept the **liability waiver, code of conduct, terms of use, and privacy policy** (with a 19+/guardian-consent confirmation): new members during sign-up, existing members via a one-time prompt. All four are versioned, and their plain text is publicly readable at `/legal/*`. Acceptances are **append-only** permanent records showing exactly who accepted which version and when.
- **Annual waiver renewal** — the liability waiver must be **re-signed every year (365 days)**. Re-signing adds a new acceptance record rather than overwriting the old one, so the full history is preserved.
- **Admin-editable legal text** — every document's wording lives in the database and is editable in the admin **Settings** page. Admins can save with **"require re-acceptance"** (a version bump re-asks the whole membership) or force a **re-signature now** — either **globally** for a document, or **per-player** from an individual member's page.
- **Event-specific tournament waivers** — a tournament can carry its own **waiver text** that players must accept at self-registration. The accepted text is fingerprinted (SHA-256), so if an admin edits the wording, previously-registered players are re-asked to accept the new version.

## ⚔️ Challenges, matches, disputes

- **Challenge flow** — a player issues a challenge, the opponent accepts, they play, and the result is reported and confirmed. Ratings update on confirmation.
- **Challenge expiry** — unanswered challenges expire automatically so they don't linger.
- **Full match records** — every match stores each player's rating before and after, the point-by-point game scores, and the rating change.
- **Head-to-head & partnership records** — the system tracks how any two players stack up against each other, and how doubles partnerships perform together.
- **Disputes & walkovers** — a proper process for contested results and no-shows, plus a **reliability** signal so flaky players are visible.

## 🌐 Public pages

- **Landing page** — a public homepage showing the live top of the ladder (great for recruitment). Logged-in members can now view it too, rather than being bounced straight to their dashboard.
- **Public leaderboard** — the full ranking, viewable without logging in (hiding anyone who opts out or isn't approved).
- **Executive page** — a public roster of the current exec team with titles.
- **Public vs member navigation** — signed-out visitors get a slim **public bar** (brand → home, Leaderboard, Execs); signed-in members get the full member navigation; execs/admins additionally get an **"Exec Panel"** button that jumps straight to the admin console.

## 🛠️ Admin console & finance

- **Role-filtered navigation** — the console shows execs the club-management tools and reserves finance/member tools for admins.
- **Member management** — admins manage player records, roles, and exec status. The role dropdown includes **Executive**, and **Suspended** and **Inactive** members have their own tabs so they don't clutter the active roster. "Add Player" **cannot create Admin accounts** (that promotion is a separate, deliberate step).
- **Audit log tools** — the audit log can be **sorted by operator or by time** and **filtered by category**, making it easy to review who did what.
- **Platform settings editor** — settings are edited one value per row, so changing a single knob no longer risks overwriting the rest.
- **Finance / income tracking** — the admin side tracks club income.
- **Announcements** — post announcements to the membership.
- **Themed confirmation dialogs** — every "are you sure?" prompt is now a branded in-app dialog rather than the browser's plain grey pop-up.

## 🔔 Notifications

- **Email** — branded club emails (login codes, reminders, announcements) via a professional email service.
- **Push notifications** — the installed app can send push notifications to phones.
- **Automated background jobs** — the system automatically expires old challenges, sends challenge/session reminders, chases up unconfirmed results, flags no-show patterns, marks inactive players, and captures season snapshots — all without anyone pressing a button.

## 🔐 Accounts & access security

- **Passkey requirement for the admin panel** — execs and admins must enrol a **passkey** (fingerprint / Face ID / device PIN, via WebAuthn) to reach the console. Anyone who hasn't enrolled is sent to an **"unavailable"** screen with a passkey-login option; access is held in a signed, tamper-proof cookie. This makes the admin panel resistant to phishing and stolen passwords.
- **Self-serve account deletion** — a member can delete their own account. It enters a **30-day grace period**, during which the member (or an admin) can **restore** it by signing back in. After 30 days a background job **anonymizes** the record permanently, in line with the data-retention policy.

## 📝 Feedback

- **Event & tournament feedback forms** — collect feedback after events.

## 📊 Monitoring & observability

- **Error tracking (Sentry)** — if something breaks for a member, the app reports the crash automatically (across the app's browser, server, and edge parts), tagged with the player it happened to, so the technical exec can find and fix it fast. Session Replay is deliberately **off** for privacy.
- **Product analytics (PostHog)** — anonymous, cookieless usage tracking (pageviews plus key actions like challenges, match results, check-ins, RSVPs, and leaderboard views) helps the exec team see what's actually used. It only tracks signed-in members and has **no session recording**.

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
