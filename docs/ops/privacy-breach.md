# Privacy breach: what to do in the first hour

For whoever is holding the technical exec role when member data is exposed, lost,
or accessed by someone who should not have it. Read the first section, then act.
The rest is reference.

> **The club carries this itself.** An earlier version of this page routed
> everything through SFU Recreation and told you never to contact the
> Commissioner directly. That was written on the assumption that the club's data
> was SFU's record, which it is not: the club manages itself, collects its own
> records, holds them on its own hardware, Recreation has no access to them, and
> the club is not an official university app. So the operating regime is **PIPA**
> (BC's Personal Information Protection Act), the club is the "organization" that
> holds the information, and **the duty to assess and to notify is the club's.**
> There is no university privacy office standing between you and it.

> ⚠️ **Confirm the exact statutory thresholds and timing before you notify.** The
> shape below is right and is enough to act on in the first hour, but the precise
> wording of PIPA's notification test and reporting form should be read from the
> OIPC's current guidance at the time, not from this page. Getting the first hour
> right does not depend on it; getting the notification right does.

---

## Do these, in this order

1. **Contain, but do not destroy.** Revoke the access, take the surface offline,
   rotate the credential. Do not delete logs, containers, database rows, or the
   evidence of what happened. The audit trail is how scope gets established
   later, and a deleted log turns a contained incident into an unbounded one,
   because nobody can then prove what was *not* taken.
2. **Write down the time** you noticed and what you saw, verbatim, before you
   start theorising. This becomes the timeline and it is much harder to
   reconstruct honestly an hour later.
3. **Tell the club's privacy officer and the exec.** If no privacy officer has
   been designated yet, that is an open gap (see below) and the decision falls to
   the exec.
4. **Preserve, then assess scope.** What personal information, whose, how many,
   and for how long it was exposed. The table below is the checklist.
5. **Then decide on notification.** Under PIPA the test is whether the breach
   could reasonably be expected to result in **significant harm** to an
   individual. If it could, both the **Commissioner (OIPC BC)** and the
   **affected members** are notified, without unreasonable delay. That call is
   the club's to make, and the bias should be toward notifying: the cost of an
   unnecessary notification is embarrassment, and the cost of a missed one is
   regulatory.
6. **Do not improvise the member-facing wording under time pressure.** Write it,
   have a second exec read it, then send. Say what happened, what information was
   involved, what you have done, and what the member should do. Do not speculate
   about cause in the first message.

---

## Who to contact

| Who | When | Note |
|-----|------|------|
| Club privacy officer / exec | Immediately | The club decides. There is no escalation path that takes this off you. |
| **Affected members** | Without unreasonable delay, if significant harm is possible | Directly, not via a Discord announcement. |
| **OIPC BC** | Same test, same timing | The club reports; see the OIPC's breach reporting guidance for the current form. |
| SFU Recreation | Only if *their* records are involved | See the note below. |

> **When Recreation does come into it.** The club's own database is not SFU's
> record, but if Recreation requires your waivers, or receives a roster from you
> for facility access or insurance, then *those specific records* may sit in
> their custody. If a breach touches anything you have handed to Recreation, tell
> them, because for that subset they may have their own FIPPA obligations. This
> is a narrow carve-out, not a general escalation route.

---

## Two gaps that will slow you down, today

- **No designated privacy officer.** PIPA requires an organization to designate
  one and make their contact available. There isn't one, so in a real incident
  the first ten minutes go on deciding who owns the decision.
- **No privacy contact address.** `docs/legal/privacy-policy.md` still points
  members at the placeholder `[PRIVACY CONTACT EMAIL]`, so there is no address a
  member could report a suspected breach *to*, and none the club can be reached
  *at*. Fill both before this page is ever needed.

---

## Where the data lives

Scope questions get answered from this list, ordered by how much personal
information is concentrated in one place, worst first.

| Location | What is in it | Notes for a breach |
|---|---|---|
| **Prod Postgres** (`supabase-db`, on the Pi) | Everything: names, emails, phones, photos, waivers, officer notes about members | `auth.users` holds the real email even for members whose `players` row has been anonymised, and `auth.audit_log_entries` holds it in `payload.actor_username` on every sign-in |
| **Nightly `pg_dump` backups** | A full copy of the above, per night | Local rolling copies, an encrypted Google Drive copy, and a second-machine copy. Deleted rows persist in older dumps, and Drive trash adds roughly 30 days invisibly on top of the stated retention |
| **The off-site copy on the Mac** | Same | Currently rsynced without encryption at rest and without `--delete`, so it accumulates. Treat it as a full unencrypted copy of the member database until that is fixed |
| **Resend** | Email addresses, delivery and bounce records | A service provider. Its suppression payloads are mirrored into `email_suppressions.detail` |
| **Sentry** | Whatever was in scope at the moment of an error | `auditable-player.ts` exists because whole player rows have historically reached places they should not. Assume error payloads may contain personal information until checked |
| **Discord** | The linked `discord_user_id` per member, plus anything typed into feedback | A snowflake plus the club roster is a re-identification path on its own |
| **The public GitHub repo** | Should be nothing | **Check this first after any accidental commit.** A `git push` of member data is a disclosure that is immediately world-readable and cached by third parties within minutes |
| **Calendar feed tokens** | A plaintext bearer token per member | Holding one lets anyone read that member's schedule with no login |

Under PIPA the club stays responsible for information it hands to a service
provider, so a breach at Resend, Sentry or Discord is still the club's breach to
assess. It does not become their problem because it happened on their side.

---

## Credential rotation, and the two traps in it

If the breach involves a leaked secret, rotate it. Two things about this system
will bite you while you do:

- **A restart does not re-read `.env`.** Editing the file and restarting the
  container leaves the old value live. See the Restart Supabase section of
  [`RUNBOOK.md`](RUNBOOK.md) for the recreate that does pick it up.
- **There is no dual-secret grace period.** Rotating a shared secret breaks every
  caller the instant it lands, so rotation is a coordinated change, not a
  one-liner. Plan the callers before you rotate, not after.

And **the backups hold the live secrets too**, so a secret that leaked via a
backup is not contained by rotating it in `.env` alone.

---

## What counts as a breach

Unauthorised access, collection, use, disclosure, or **loss** of personal
information. Loss counts: a misplaced unencrypted backup copy is a breach even if
nobody is known to have read it. So is an accidental disclosure to the wrong
member, and so is member data reaching the public repo.

"Significant harm" is the notification threshold and it is broader than financial
loss. It covers identity theft and fraud, but also humiliation, damage to
reputation or relationships, and loss of employment or professional opportunity.
For this club the realistic shapes are a roster of names and emails becoming
public, officer notes written about a member being exposed, or a member's
schedule and attendance being readable by someone they did not choose.

---

## After

Write what happened, what was exposed, what was done, and what changed so it
cannot recur, and put it where the next exec will find it. An incident nobody
recorded gets repeated by whoever inherits the role.
