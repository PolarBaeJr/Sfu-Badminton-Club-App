# 3 · What's Coming Next (Roadmap)

*The planned features, in plain language. These are committed — grounded in what already exists so they're realistic to build. They're grouped into delivery "waves" by priority and dependency. Effort is a rough guide: **S** = quick, **M** = a few days, **L** = a bigger project.*

---

## The 14 committed features

### 🔐 Access & permissions
- **A1 · Permissions overhaul** *(L)* — permission **groups**, finer **access tiers** (beyond today's exec/admin), and **single-use / temporary elevated access** (grant someone admin powers for one action or a limited time, fully logged). This is the keystone that unlocks exec handover, coach roles, and two-factor login for admins.

### 💰 Money
- **A6 · Online fee payment** *(L)* — members pay their season fees **online** (card / e-transfer), with automatic receipts and reconciliation against who owes what. Today fees are only *tracked*; this actually collects them.
- **A13 · Tournament entry fees & prize pools** *(M)* — charge entry fees online at tournament registration and track prize pools/payouts. *(Builds on A6.)*

### 🙋 Attendance & sessions
- ~~**A2 · Richer session attendance** *(S–M)*~~ — ✅ **Shipped 2026-07-19.** No-show/excused/present marking by execs and admins (audited), walk-in adds, server-enforced check-in windows, and real session start/end times. See [02-completed.md](02-completed.md).
- **A3 · Google Calendar attendance** *(L)* — send calendar invites for sessions and mark attendance from **RSVPs**. *(The heaviest of the batch; we'll weigh it against a cheaper door-QR check-in first.)*
- **A10 · Subscribe-to-calendar feed** *(S–M)* — members subscribe once and their sessions **auto-appear** in their calendar going forward.
- **A11 · Offline-first check-in & scoring** *(M)* — check in and score matches even when the venue's wifi is bad; actions queue and sync when back online.
- **A14 · Predictive attendance** *(M)* — forecast how many people will show up to a session (from history) so execs can plan **shuttles and courts**.

### 🏸 Competitive depth *(A12 — a bundle)*
- **Better ratings** — a more accurate rating model that shows how *confident* it is in each player's rank, plus **pre-match win probability** ("you're 68% favored").
- **New formats** — **box leagues** (small round-robin groups that promote/relegate), **skill divisions** (A/B/C ladders), and **Swiss-style** tournaments.
- **Doubles as first-class** — proper **pair ratings** and a doubles leaderboard.
- **A8 · Partner finder** *(M)* — get matched with a doubles partner by skill, availability, and style.
- **Fair play & integrity** — challenge cooldowns, **anti-sandbagging** detection, handicap games for mixed skill, and a sportsmanship rating.
- **Recognition** — season awards (MVP, most-improved, giant-killer), streak badges, and rivalry match-ups.

### ⚖️ Safety & compliance
- ~~**A7 · Liability waivers & code of conduct** *(S)*~~ — ✅ **Shipped 2026-07-19.** Versioned acceptance (onboarding step + blocking prompt for existing members), play actions blocked until accepted, and the legal text is editable in Admin → Settings. See [02-completed.md](02-completed.md).

### 📅 Structure
- **A9 · Semester/term-aware scheduling** *(M)* — Fall / Spring / Summer terms built in, with fees and memberships scoped per term.

### 📊 Data
- **A5 · Open read-only data feed** *(M)* — a safe, privacy-respecting way to pull match/results data out to build **stats models** (e.g. win/loss prediction, a "who should I play" recommender), plus CSV export.

### 🔧 Tournaments
- ~~**A4 · Tournament suspension** *(S–M)*~~ — ✅ **Shipped 2026-07-19.** Pause with a reason / resume cleanly; registration, check-in, brackets, and scoring are blocked while suspended, and everyone sees why. See [02-completed.md](02-completed.md).

---

## Suggested delivery order (waves)

1. **Quick wins** — ✅ *mostly done 2026-07-19:* richer attendance (A2), tournament suspend (A4), and waivers (A7) have shipped. Still open from this wave: the cheap competitive-depth pieces (win probability, rivalries, season awards).
2. **Payment rail** — online fee payment (A6), then tournament entry fees (A13).
3. **Permissions keystone** — the access overhaul (A1), which unlocks a whole cluster of later features.
4. **Data & scheduling** — term-aware scheduling (A9), predictive attendance (A14), and the open data feed (A5) with a personal stats dashboard.
5. **Competitive & experience depth** — partner finder + pair ratings, new formats (box leagues / divisions), offline check-in, calendar subscribe.
6. **Heaviest / revisit** — full Google Calendar RSVP attendance (A3) and the upgraded rating model.

---

## Also on the table (not yet committed)

A longer list of ideas we've captured for future consideration, including: session capacity + waitlists, court allocation, membership renewals, a merch store, door-QR / wallet-pass check-in, a phone-as-scoreboard live mode, coach roles + drills, richer player profiles, gamification (badges, hall of fame), a churn/disengagement flag for exec outreach, a full finance dashboard, exec task boards, sponsorship management, SFU single-sign-on, privacy self-service (data export/delete), inter-university fixtures, and accessibility/inclusivity improvements (para categories, localization).

*These are parked as candidates — they can be promoted into the committed list anytime.*

➡️ Continue to **[04-security.md](04-security.md)** for how everything is kept safe.
