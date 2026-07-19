# 5 · How It's Hosted, Deployed & Run

*The practical operations side — how the app stays online, how updates ship, how data is kept safe, and what it costs. Kept non-technical.*

---

## Where it lives

- The app is **self-hosted** on the club's own small computer (a Raspberry Pi), not rented from an expensive cloud provider.
- It's reachable at **[badminton.polardev.org](https://badminton.polardev.org)** over a secure (HTTPS) connection.
- The database and all core services run on that same self-hosted setup, under the club's control.

**Why this matters:** the club **owns its data and its infrastructure**, and the running cost is minimal.

## How updates ship (and why it's safe)

- When a change is made, an **automated build system** packages a fresh, tested version of the app.
- Every version is **stamped and archived**, so we can always roll back to a previous known-good version if something goes wrong.
- The server then **automatically picks up** the new version and deploys it — no manual, error-prone steps.
- Critically, **updating the app never touches the members' data** — the database and the app are kept separate, so a deploy can't accidentally wipe or corrupt records.

## Data safety & backups

- **Nightly backups** of the entire database.
- Backups are kept for a **rolling window** locally, and copied **off-site** — to encrypted cloud storage (Google Drive) and a second machine.
- Backups are **encrypted** before they leave, so even the off-site copies are protected.
- This means the club can **recover** from hardware failure, accidental deletion, or worse.

## Reliability

- The app is designed to keep running unattended, with **automated background jobs** handling routine upkeep (reminders, cleaning up expired items, taking season snapshots).
- Because updates auto-deploy and data is backed up nightly, day-to-day operation needs **very little hands-on attention**.

## What it costs to run

Roughly speaking, the ongoing cost is **near zero**:

| Item | Cost |
|------|------|
| Hosting (self-hosted on club hardware) | ~$0 (uses existing equipment + electricity) |
| Database (self-hosted) | $0 (no monthly SaaS fee) |
| Domain name | Low annual fee |
| Email + build/hosting services | Free tiers |
| Off-site backup storage | Covered by an existing storage plan |

**Bottom line:** the app delivers a full club-management + competitive-ladder platform for essentially the cost of a domain name and some electricity — no per-member fees, no expensive subscriptions.

## What this means for the exec team

- **No vendor lock-in** — the club controls its own app and data.
- **Cheap to keep running** — no budget line for a SaaS subscription.
- **Safe to grow** — new features ship through the same tested, reversible pipeline, and every change is security-reviewed.

---

*See also: [04-security.md](04-security.md) for the full security picture, and [02-completed.md](02-completed.md) for the feature list.*
