# Design: exec portfolios + a permission editor

## The problem

Access today is one ordered ladder in `apps/admin/src/lib/permissions.ts`:

    admin > exec > trainer

`admin` = `role='admin'`, `exec` = `is_exec`, `trainer` = `is_trainer`. A section
is described by the MINIMUM level that may enter it, and everything above is
admitted automatically.

The club's real structure is not a ladder. It has four VP portfolios —
**Finance**, **Tournaments**, **Internal** (members/roster), **External**
(legal/comms) — plus admins and a varsity trainer. One `is_exec` boolean cannot
express any of that, so today **every exec gets identical access**: the VP of
Tournaments can open the club's books, and the VP of Finance can regenerate a
draw.

Measured, so nobody re-surveys it:
- 27 `canAccess(...)` call sites in the admin app
- ~93 exec-or-admin gate call sites across server actions, ~78 `is_exec` refs
- 18 entries in `SECTION_ACCESS`
- **exactly 1 RLS policy references `is_exec`** — the database barely encodes
  this, so it is overwhelmingly an app-layer change. That single fact is what
  makes it tractable.

## The shape: portfolios, not free-form capabilities

Capability strings (`view.finances.otherincome`) are infinitely flexible, which
means nothing enumerates them and a typo is a silent hole. The club has a small
number of NAMED JOBS, not arbitrary permissions. So: a closed set.

    portfolio ∈ { finance, tournaments, internal, external }

`admin` stays a superuser and is unaffected. `trainer` is unaffected.

## The rule (this is the important part)

**A portfolio NARROWS an exec. It never widens anyone.**

- `players.portfolio IS NULL` → that exec keeps exactly today's access. No
  behaviour change for a single existing row.
- `players.portfolio = 'finance'` → that exec may enter only the sections the
  finance portfolio grants, plus the baseline below.

This makes the migration a no-op on deploy and every subsequent change an
explicit, reversible act by an admin.

Baseline every console user keeps regardless of portfolio (these are not
powers): `/`, `/dashboard`, `/settings`, `/api/passkey`.

Proposed grants — **the reviewer should challenge these**:

| portfolio   | sections |
|-------------|----------|
| finance     | `/fees` |
| tournaments | `/tournaments`, `/matches`, `/sessions` |
| internal    | `/players`, `/seasons` |
| external    | `/legal`, `/announcements` |

## The part that is easy to get wrong

`canAccess()` feeds **middleware and nav only**. The REAL boundary is the server
action — `getExecOrAdmin()`, used ~93 times, which bypasses RLS via the service
role. **A portfolio that only narrows the UI is theatre**: the VP of Tournaments
would still be able to call the finance server actions directly.

So the work is in two halves and BOTH are required:
1. `canAccess()` gains the portfolio → nav and middleware narrow.
2. `getExecOrAdmin()` gains a required "which portfolio does this action belong
   to" argument → the server actions narrow.

For (2) the signature change must be **compile-time enforced**, not optional.
An optional parameter fails OPEN: every call site that forgets it keeps full
exec access, and there are ~93 of them. Make TypeScript find them.

Same for `canAccess`: prefer a required parameter over an optional one.

## Permission editor

Admin-only page (or a section of `/players`) listing execs with a portfolio
selector. Assigning is an admin action, audited like every other privileged
change. Must NOT be reachable by an exec — `players.portfolio` is a privilege
column and belongs with the other guarded ones in
`guard_player_privileged_columns` (see the trigger in the live DB; it already
refuses non-admin writes to `role`, `is_exec`, `is_trainer`, `exec_title`).

## Constraints

- Migration number **00086**. Apply to STAGING only; production migrations are
  the owner's to run.
- `players.portfolio` must be added to the privileged-column guard trigger.
- Gate must be green: `npm run build`, `npm run lint`, `npm run test`.
- Push to `deploy/docker-staging`. Do NOT push to `deploy/docker-prod`.
- The app is LIVE. Nothing may reduce an existing user's access on deploy.

## Open questions for the reviewer

1. Is "narrow-only, NULL = today" the right migration strategy, or does it
   leave the club permanently in the old model because nobody assigns anything?
2. Should a person be able to hold MORE THAN ONE portfolio? (A small club often
   has one person doing Finance and External.) A single enum column cannot; an
   array or join table can, at the cost of complexity.
3. Are the section grants above right, and what breaks at the seams — e.g.
   `/fees` is exec-level ONLY so an exec can reach the Expenses tab, while club
   fees and income are admin-only INSIDE the page. Does "finance portfolio"
   change that split?
4. `/tournaments/<id>/fees` is admin-only via `ADMIN_ONLY_PATTERNS`. Should the
   finance portfolio reach it?
5. Is there a safer sequencing than one big change — e.g. ship the column and
   the editor first with enforcement behind a flag?
