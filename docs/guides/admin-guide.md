# Admin & Exec Guide

How to run the club from the admin console. Non-technical — for execs and admins using the app, not developers.

**Console:** [badminton.polardev.org/admin](https://badminton.polardev.org/admin)

## Access levels

There are two levels of console access:

- **Executive** — can manage the day-to-day: **sessions, tournaments, matches, announcements, seasons**.
- **Admin** — everything execs can do, **plus** the sensitive areas: **fees, member records, disputes, walkovers, settings**.

You'll only see the menu items your level allows. If you should have more access, ask a current admin to update your role under **Members**.

---

## Seasons (do this first each term)

Seasons are the backbone — sessions and fees attach to the active season.

1. **Create a season** and set its **competitive** and **recreational** fee amounts.
2. **Activate** it. Only one season is active at a time.
3. When you activate a new season, you choose a **rating reset policy**:
   - **Keep** — everyone keeps their current rating.
   - **Soft compress** — ratings pull gently toward the middle (fresh-ish start, keeps relative order).
   - **Full reset** — everyone back to the starting rating.
   - You'll get a **confirmation prompt** — this is a big action.
4. The previous season's final standings are **archived** automatically (for awards and records).

---

## Sessions

1. **Create a session**: date, venue, and **track** (Competitive, Recreational, or All). It auto-attaches to the active season.
2. Members **check themselves in** from their phones.
3. Open a session to see the **attendance roster** and counts.
4. **Close** a session when it's done (this is the archive state).

---

## Running a tournament

1. **Create the tournament** (starts as a draft).
2. Add one or more **events** (e.g. Men's Singles, Mixed Doubles).
3. Move an event through its phases:
   - **Registration** — players sign up.
   - **Check-in** — players check in on event day (you can also check them in, including in bulk).
   - **Bracket** — generate the bracket (auto-**seeded by rating** so top players don't meet early).
   - **Live** — record match results as they happen.
   - **Completed** — **finalize** the event, which applies placement bonuses to ratings.
4. Set the tournament to **active** while it's running; **archive** it when fully done.
5. **Tournament fees** are admin-only.

---

## Members

- **View and edit** member records.
- **Change roles** — promote to admin, grant/remove **executive** status, set an **exec title** (shown on the public exec page).
- Mark a member **fee-exempt** where appropriate.

---

## Fees (admin only)

- Fees follow the **active season** and its track amounts.
- Track who has paid / owes.
- *(Online payment collection is on the roadmap — today this is tracking.)*

---

## Announcements

- Post announcements to the membership (they can be emailed).

---

## Disputes & walkovers (admin only)

- Handle contested match results and no-shows through the proper flow, which keeps the ladder fair and updates reliability.

---

## Good habits

- **One active season** at a time — set it up at the start of each term.
- **Communicate reset policy** before activating a new season (it moves everyone's rating).
- Sensitive changes are **logged** — that's a feature, not surveillance; it protects the club.
- If something looks broken, note what you clicked and tell the technical exec (see the [runbook](../ops/RUNBOOK.md)).
