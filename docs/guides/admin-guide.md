# Admin & Exec Guide

How to run the club from the admin console. Non-technical — for execs and admins using the app, not developers.

**Console:** [Admin.sfubadminton.com](https://admin.sfubadminton.com)

## Access levels

There are two levels of console access:

- **Executive** — can manage the day-to-day: **sessions, tournaments, matches, announcements, seasons**.
- **Admin** — everything execs can do, **plus** the sensitive areas: **fees, member records, disputes, walkovers, settings**.

You'll only see the menu items your level allows. If you should have more access, ask a current admin to update your role under **Members**.

---

## Setting up your passkey (required)

The console is protected by a **passkey** — your phone or laptop's fingerprint, Face ID, or device PIN. This is on top of your normal login, and it's required for every exec and admin.

- The **first time** you open the console, you'll be taken to an **"unavailable"** screen with a button to enrol a passkey. Follow the prompt (your device will ask for your fingerprint / Face ID / PIN). Once enrolled, you're in.
- After that, the console remembers your device. If you switch to a new phone or laptop, you'll be sent back to that screen to enrol a passkey on the new device.
- If you ever land on the "unavailable" screen unexpectedly, use the **passkey login** option there to get back in.

This means a stolen password alone can't reach the admin tools — someone would also need your physical device.

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
2. Members **RSVP** ahead of time ("Going" / "Can't make it") and **check themselves in** from their phones on the day.
3. Open a session to see the **attendance roster** and counts. You'll also see the **RSVPs** — the list of members who said they're **going** and who said they **can't make it** — which helps you plan courts before anyone arrives. RSVP is just intent; it's separate from the actual check-in.
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
6. **Event waiver (optional)** — a tournament can carry its own **waiver text** (e.g. extra rules or a photo-release for that event). If you set one, players must **accept it when they register**. If you later edit the wording, anyone who already accepted is automatically **re-asked** to accept the new version, so consent always matches the current text.

---

## Members

- **View and edit** member records.
- **Change roles** — promote to admin, grant/remove **executive** status, set an **exec title** (shown on the public exec page). Note: **"Add Player" can't create an admin** — promoting someone to admin is a separate, deliberate step on their member page.
- Mark a member **fee-exempt** where appropriate.
- **Active / Suspended / Inactive tabs** — the member list is split into tabs so suspended and inactive members don't clutter your day-to-day active roster.
- **Force a waiver re-signature for one member** — on a member's page you can require **that person** to re-sign the waiver next time they open the app (useful if their details changed or something needs re-confirming). To re-ask *everyone*, use the **Legal documents** tools below instead.
- **Restore a deleted account** — if a member deleted their account, you have **30 days** to bring it back: open their record and **cancel the deletion**. The member can also restore it themselves just by signing back in within that window. After 30 days the account is permanently anonymized and can't be recovered.

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

## Legal documents (admin only)

The club's four legal documents — **liability waiver, code of conduct, terms of use, and privacy policy** — live in **Settings** and are editable there. The waiver also **renews yearly**: members are automatically re-asked to sign it once a year.

When you edit a document you have a few choices:

- **Save** — fix a typo or make a minor change without disturbing anyone.
- **Save & require re-acceptance** — save a meaningful change and bump the version, which **re-asks every member** to accept it the next time they open the app.
- **Require re-signature now** — force everyone to re-sign a document immediately, without changing its text (e.g. after a policy discussion).

To re-ask just **one person** instead of the whole club, use **force a waiver re-signature** on that member's page (see Members).

---

## Audit log (admin only)

Sensitive actions are logged automatically. In the audit log you can:

- **Sort by operator** (who did it) or **by time** (when).
- **Filter by category** to focus on one type of change.

This makes it quick to answer "who changed this, and when?"

---

## Good habits

- **One active season** at a time — set it up at the start of each term.
- **Communicate reset policy** before activating a new season (it moves everyone's rating).
- Sensitive changes are **logged** — that's a feature, not surveillance; it protects the club.
- If something looks broken, note what you clicked and tell the technical exec (see the [runbook](../ops/RUNBOOK.md)).
