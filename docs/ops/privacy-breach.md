# Privacy breach: what to do in the first hour

For whoever is holding the technical exec role when member data is exposed, lost,
or accessed by someone who should not have it. Read the first section, then act.
The rest is reference.

> **The club is almost certainly not the decision maker here.** The club operates
> under SFU Recreation, which makes SFU the public body under FIPPA and SFU's
> privacy office the authority on whether a breach is notifiable and who gets
> told. Your job is to contain it and report it quickly and completely. It is
> **not** your job to decide whether it was serious enough to matter, and it is
> not your call to make notifications on the university's behalf. Getting that
> wrong in the cautious direction costs an awkward email. Getting it wrong in the
> other direction is the club's problem and the university's problem at once.

---

## Do these, in this order

1. **Contain, but do not destroy.** Revoke the access, take the surface offline,
   rotate the credential. Do not delete logs, containers, database rows, or the
   evidence of what happened. The audit trail is how the scope gets established
   later, and a deleted log converts a contained incident into an unbounded one,
   because nobody can then prove what was not taken.
2. **Write down the time** you noticed and what you saw, verbatim, before you
   start theorising. This becomes the timeline and it is much harder to
   reconstruct honestly an hour later.
3. **Tell the exec team**, then **escalate to SFU**. See Escalation below.
4. **Do not notify members yourself**, and do not post about it in the Discord
   or anywhere else. Notification wording under FIPPA is the public body's, and
   an early well-meant message is both wrong and unretractable.
5. **Preserve, then assess scope.** What personal information, whose, how many,
   and for how long it was exposed. The Where the data lives table below is the
   checklist for that question.

---

## Escalation

| Who | When | Note |
|-----|------|------|
| Club exec / president | Immediately | They own the relationship with Recreation. |
| **SFU Recreation** staff contact | Immediately after the exec | They route to the university's privacy office. |
| **SFU privacy office** (Information and Privacy Office) | Same day | The authority on notifiability and on notifying the OIPC. |
| OIPC BC | **Never directly by the club.** | The public body reports to the Commissioner, not the club. |

> ⚠️ **There is no club privacy contact address yet.** `docs/legal/privacy-policy.md`
> tells members to write to `[PRIVACY CONTACT EMAIL]`, an unfilled placeholder. So
> today there is no address a member could report a suspected breach *to*, and no
> address the club could be reached *at*. Fill it before this document is ever
> needed. Until it is filled, the practical inbound route is whatever address the
> exec actually reads, and that is not written down anywhere either.

---

## Where the data lives

Scope questions get answered from this list. It is ordered by how much personal
information is concentrated in one place, worst first.

| Location | What is in it | Notes for a breach |
|---|---|---|
| **Prod Postgres** (`supabase-db`, on the Pi) | Everything: names, emails, phones, photos, waivers, officer notes about members | `auth.users` holds the real email even for members whose `players` row has been anonymised, and `auth.audit_log_entries` holds it in `payload.actor_username` on every sign-in |
| **Nightly `pg_dump` backups** | A full copy of the above, per night | Local rolling copies, an encrypted Google Drive copy, and a second-machine copy. Deleted rows persist in older dumps, and Drive trash adds roughly 30 days invisibly on top of the stated retention |
| **The off-site copy on the Mac** | Same | Currently rsynced without encryption at rest and without `--delete`, so it accumulates. Treat it as a full unencrypted copy of the member database until that is fixed |
| **Resend** | Email addresses, delivery and bounce records | A processor. Its suppression payloads are mirrored into `email_suppressions.detail` |
| **Sentry** | Whatever was in scope at the moment of an error | The reason `auditable-player.ts` exists is that whole player rows have historically reached places they should not. Assume error payloads may contain personal information until checked |
| **Discord** | The linked `discord_user_id` per member, plus anything typed into feedback | A snowflake plus the club roster is a re-identification path on its own |
| **The public GitHub repo** | Should be nothing | **This is the vector to check first after any accidental commit.** Member emails, names, and IPs must never be committable. A `git push` of member data is a disclosure that is immediately world-readable and cached by third parties within minutes |
| **Calendar feed tokens** | A plaintext bearer token per member | Holding one lets anyone read that member's schedule with no login |

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

And note that **the backups hold the live secrets too**, so a secret that leaked
via a backup is not contained by rotating it in `.env` alone.

---

## What counts as a breach

Unauthorised access, collection, use, disclosure, or **loss** of personal
information. Loss counts: a misplaced unencrypted backup drive is a breach even
if nobody is known to have read it. So is an accidental disclosure to the wrong
member, and so is member data reaching the public repo.

Under FIPPA the public body must notify affected individuals and the Commissioner
where the breach could reasonably be expected to result in **significant harm**,
which explicitly includes identity theft, humiliation, damage to reputation or
relationships, and loss of employment or professional opportunity. That
assessment is SFU's to make. Report and let them make it.

---

## After

Write what happened, what was exposed, what was done, and what changed so it
cannot recur, and put it where the next exec will find it. An incident nobody
recorded gets repeated by the person who inherits the role.
