# Database backups

Three tiers, all free. Do them in order — tier 1 alone already protects you
against the most common disaster (a bad migration or an accidental mass-delete).

| Tier | What | Protects against | Where |
|---|---|---|---|
| 1 | Nightly `pg_dump`, 14-day retention | logical errors (bad migration, bad delete) | on the Pi |
| 2 | Pull dumps to this Mac | Pi disk/hardware failure | this Mac |
| 3 | Encrypted push to Google Drive | total Pi **and** Mac loss | Google Drive |

> ⚠️ **The dump contains member PII** (names, emails, phones). Never commit a
> dump to git (this repo is public). Any cloud copy must be **encrypted** — tier
> 3 uses `rclone crypt` so Google only ever stores ciphertext.

---

## Tier 1 — nightly dump on the Pi

`backup-db.sh` runs `docker exec supabase-db pg_dump` (custom format) into
`~/ssd/db-backups`, keeps 14 days, and — if `rclone` is set up (tier 3) — pushes
each dump to the encrypted remote.

```sh
# on the Pi, once the repo is pulled to ~/ssd/Deploy/badminton
chmod +x ~/ssd/Deploy/badminton/backup/backup-db.sh
mkdir -p ~/ssd/db-backups

# test it
RCLONE_REMOTE= ~/ssd/Deploy/badminton/backup/backup-db.sh   # empty = skip cloud

# cron — daily 03:30
crontab -e
# 30 3 * * * ~/ssd/Deploy/badminton/backup/backup-db.sh >> ~/ssd/db-backups/backup.log 2>&1
```

## Tier 2 — pull to this Mac

`pull-to-mac.sh` rsyncs the dumps down over SSH. Schedule it with the launchd
plist (runs 09:00 daily; catches up on next wake if the Mac was asleep).

```sh
# on the Mac
chmod +x <repo>/backup/pull-to-mac.sh
<repo>/backup/pull-to-mac.sh        # test — pulls into ~/badminton-backups

# schedule
cp <repo>/backup/com.badminton.dbpull.plist ~/Library/LaunchAgents/
# edit the ProgramArguments path in the plist to the ABSOLUTE path of pull-to-mac.sh
launchctl load ~/Library/LaunchAgents/com.badminton.dbpull.plist
```

## Tier 3 — encrypted → Google Drive (2 TB account)

One-time `rclone` setup. The OAuth step is **yours to do interactively** — I
can't authorize your Google account.

```sh
# on the Pi
curl https://rclone.org/install.sh | sudo bash    # or: apt install rclone

# 1. Google Drive remote (OAuth). On a headless Pi:
#    run `rclone authorize "drive"` on the Mac (has a browser), paste the token here.
rclone config
#   n) new remote  → name: gdrive  → storage: drive  → follow prompts / paste token

# 2. Encrypted wrapper over a folder in that Drive:
rclone config
#   n) new remote  → name: gcrypt  → storage: crypt
#     remote:            gdrive:badminton-backups
#     filename_encryption: standard
#     password:          <STRONG PASSWORD>          # SAVE THIS IN YOUR PASSWORD MANAGER
#     password2 (salt):  <generate>                 # save this too

# verify
echo hi | rclone rcat gcrypt:hello.txt && rclone cat gcrypt:hello.txt && rclone delete gcrypt:hello.txt
```

> 🔑 **Save the `gcrypt` password (and salt) in your password manager.** They are
> NOT stored on Google. Lose them and every cloud backup is permanently
> unrecoverable. This is the single point of failure for encrypted backups.

Once `gcrypt:` works, `backup-db.sh` uploads to it automatically (its default
`RCLONE_REMOTE=gcrypt:`).

---

## Restoring

> ### ⚠️ Read this before relying on a restore
>
> **The dumps these scripts currently produce carry no roles and no grants.**
> `pg_dump` never emits roles at any flag combination, and the `--no-acl` in the
> commands below suppresses table privileges as well. Every table in `public`
> carries two or three explicit ACL entries, so a restore from one of these
> dumps yields a database in which `anon` and `authenticated` can read
> **nothing**.
>
> That failure is silent, which is what makes it dangerous: a denied PostgREST
> read comes back as an *empty list*, not an error — so a restored site serves
> 200s with no data rather than failing loudly.
>
> The fix — a nightly `pg_dumpall --globals-only --no-role-passwords` companion
> file, `--no-acl` dropped from both the dump and the restore, both files
> treated as one unit, and retention/rsync patterns widened to match — is
> written and pushed on branch **`fix/backup-globals-and-acls`**, but is **not
> merged**. Until it is:
>
> - restore **globals first**, then the dump, and drop `--no-acl`;
> - expect step 1 to print `role "anon" already exists` against a fresh Supabase
>   container and still exit 0 — `pg_dumpall --globals-only` emits bare,
>   unguarded `CREATE ROLE`. Capture stderr and check that "already exists" is
>   the *only* error rather than eyeballing the output;
> - note the restore path on that branch is **reasoned, not exercised** — no
>   scratch restore has been performed. Inferred is not observed.
>
> `_supabase` is deliberately not dumped: all five `_supavisor` tables are empty
> and their content is pooler state rebuilt from env on startup. Skipping it is
> correct.

Dumps are Postgres **custom format** (`-Fc`), restored with `pg_restore`.

```sh
# from a local (or Mac) dump:
docker exec -i supabase-db pg_restore -U postgres -d postgres \
  --clean --if-exists --no-owner --no-acl < badminton-YYYYMMDDT......Z.dump

# from the encrypted cloud — decrypt/download first:
rclone copy gcrypt:badminton-YYYYMMDDT......Z.dump ./
docker exec -i supabase-db pg_restore -U postgres -d postgres \
  --clean --if-exists --no-owner --no-acl < badminton-YYYYMMDDT......Z.dump
```

`--clean --if-exists` drops existing objects before recreating them, so the
restore replaces current data with the backup. **Test a restore into a scratch
database at least once** before you rely on it — an untested backup is a hope,
not a backup.

> ### After any restore: re-apply deletions
>
> A restore replaces the live database with an older one, so members deleted
> since that dump was taken can come back. Whether the system heals itself
> depends on one thing: **whether the dump is older or newer than the deletion
> request.**
>
> - **Dump taken after the request: self-healing, and no action needed.** The
>   row carries its `deletion_requested_at` tombstone, so the nightly purge sees
>   a request more than 30 days old and re-anonymises it. Already-purged rows
>   are safe for the same reason: they keep the tombstone and the
>   `deleted+…@deleted.invalid` sentinel, which is what marks them done.
> - **Dump taken before the request: NOT self-healing, and nothing reports it.**
>   The restore erases the request along with everything else. There is no
>   tombstone, so the purge has no reason to look at that row, and the member is
>   back permanently with their real name, email and phone.
>
> That second case is not exotic. The request waits 30 days for the purge while
> the dumps only go back 14, so any restore performed in the weeks after a
> request can land on a dump that predates it.
>
> So after a restore, before the site is serving again:
>
> 1. List who requested deletion since the dump was taken. This is why a
>    deletion request has to be recorded somewhere **outside the database it
>    deletes from**: restoring that database is exactly when you need the list,
>    and that is exactly when it is gone.
> 2. Re-enter the request for anyone missing it, then run the purge by hand
>    rather than waiting for 04:05, so the window is minutes.
> 3. Write down that you did it, with the date.
>
> **Step 2 currently has no button.** The only writer of `deletion_requested_at`
> in the whole codebase is `deleteMyAccount`
> (`apps/player/src/lib/actions/profile.ts:313`), which requires the member to
> be signed in and to type a confirmation. The admin console can only
> **cancel** a deletion (`cancelAccountDeletion`), never start one. So a member
> whose request a restore erased cannot be re-deleted by an officer at all, and
> they will not do it again themselves because as far as they know it already
> happened.
>
> Until an admin-initiated deletion exists, step 2 means a hand-written SQL
> update against production, which is exactly the kind of manual write that
> gets skipped or fumbled during an incident. Treat that as the gap it is.
>
> This is not optional politeness. Bounded backup retention is only defensible
> as a deletion practice on the condition that a restore re-applies the
> deletions, and a restore that quietly resurrects deleted members turns an
> honoured request into an unhonoured one.

---

## Retention, and what it has to do with deleting a member

The three tiers expire on their own schedules, and those windows are the reason
the club can honestly tell a member they have been deleted.

| Tier | Window | Notes |
|---|---|---|
| 1, Pi | 14 days | `RETAIN_DAYS` in `backup-db.sh`, swept nightly |
| 2, Mac | 14 days | `RETAIN_DAYS` in `pull-to-mac.sh`, swept after each successful pull |
| 3, Drive | 14 days **plus roughly 30** | `rclone delete --min-age`, then Google's trash holds it invisibly on top |

So a member deleted today is gone from the live database at once, off the Pi and
this Mac within about two weeks, and out of Drive in roughly six.

**Keep tier 1 and tier 2 on the same number.** Tier 2 exists to survive the loss
of tier 1, so a Mac window longer than the Pi's does not buy more safety, it
just holds personal information for longer than the club has said it does.

> **Tier 2 went unbounded for its whole life until 2026-09-21.** `pull-to-mac.sh`
> had no sweep at all, so nothing on this Mac had ever expired. Combined with
> the outage below, it was sitting on a frozen July snapshot of every member,
> including people who had asked to be deleted since. Both are fixed; the point
> worth keeping is that **an unbounded backup makes a deletion promise untrue**,
> and nothing in the system would have reported it.

### Tier 2 was dead from 2026-07-20 to 2026-09-21

`pull-to-mac.sh` hardcoded `polardev.org:2222`, which is a verbatim copy of the
`pi-remote` block in `~/.ssh/config`. That domain was retired, so every run
failed with ssh's exit 255 while the launchd job kept firing daily. The dumps
already on disk made it look healthy from the outside for two months.

It now connects by **ssh alias** (`pi`, falling back to `pi-lan`), so connection
details live in one place and a host move cannot strand it again. Check it is
alive the fast way, which is the state file rather than the log:

```sh
cat ~/badminton-backups/.last-pull          # timestamp of the last successful pull
launchctl list | grep badminton             # second column is the last exit status; 0 is good
ls -1 ~/badminton-backups/*.dump | wc -l    # should be near the retention window
```

A non-zero exit status there means the off-site copy is stale, and the script
prints the last good pull date when it fails. It never sweeps on a failed run,
so a bad night costs you freshness and never the backup itself.

### Still open: tier 2 is unencrypted

Tier 3 encrypts before the data leaves the Pi, so Google only ever holds
ciphertext. Tier 2 does not. These dumps sit in `~/badminton-backups` in
plaintext, and anyone with access to this Mac has every member's name, email,
phone and waiver without needing a key. `pull-to-mac.sh` prints a warning on
every run until a `.encryption-configured` marker exists in that directory.

Fixing it needs a tool that is not installed on this Mac (`age` and `gpg` are
both absent, and rclone has no config file here) and a key that is the owner's
to create, so it is deliberately left as a decision rather than guessed at.

---

## Troubleshooting the off-site upload

### Symptom: local dumps fine, nothing reaching Drive

The nightly dump and the upload fail independently, and until Aug 2026 only the
dump was visible from the outside — so a broken upload looked like a healthy
backup. Check the upload state file first, it is the fastest signal:

```sh
cat ~/ssd/db-backups/.last-upload        # timestamp of the last VERIFIED upload
grep -c 'BACKUP UPLOAD FAILED' ~/ssd/db-backups/backup.log
rclone lsf gcrypt: | sort | tail -5      # is today's dump actually there?
```

> **On the Mac mini, that size comparison is broken.** BSD `wc -c` left-pads its
> count where GNU's does not, so the verify reports a spurious mismatch — and
> that path exits 1, failing every backup. Fixed on
> `fix/backup-globals-and-acls`, unmerged.

`backup-db.sh` writes `.last-upload` only after confirming the uploaded object
exists at the expected size, prints a greppable `BACKUP UPLOAD FAILED` line on
any failure, and exits non-zero — but it still writes the local dump and still
runs local retention, so one broken leg never costs you the other.

### `oauth2: "invalid_client" — The OAuth client was not found.`

This is what a corrupted `rclone.conf` looks like. Seen 2026-07-29 → 2026-08-03:
the `[gdrive]` section's `client_id` had been overwritten with the OAuth **token
JSON** (`client_id` was byte-identical to `token`), and `client_secret` was
absent — so rclone sent a JSON blob as its client id. 15 days of dumps never
left the Pi.

Inspect without printing secrets:

```sh
python3 -c "
import configparser, os
c = configparser.ConfigParser(); c.read(os.path.expanduser('~/.config/rclone/rclone.conf'))
g = dict(c.items('gdrive'))
print({k: f'<{len(v)} chars>' for k, v in g.items()})
print('client_id looks like a token:', g.get('client_id','').lstrip().startswith('{'))
"
```

Fix: back up the config, delete the bogus `client_id` line from `[gdrive]`, and
rclone falls back to its built-in OAuth client. The existing `refresh_token`
keeps working, so **no re-authorisation is needed** — verify with
`rclone lsd gdrive:`.

### 403 `Quota exceeded ... 'Queries per minute'`

rclone's built-in OAuth client is shared by every rclone user, so Google
rate-limits it globally — expect roughly one failure in three on any given
call. It clears in seconds, which is why the upload retries (`--retries 8
--retries-sleep 15s`).

To remove it entirely, create your own Drive OAuth client (free) and set both
values — this is the only part that needs a browser:

1. Google Cloud Console → new project → enable the **Google Drive API**.
2. OAuth consent screen → External → add your own account as a test user.
3. Credentials → Create OAuth client ID → **Desktop app**.
4. On the Pi: `rclone config update gdrive client_id <ID> client_secret <SECRET>`
   then `rclone config reconnect gdrive:` (run `rclone authorize "drive"` on a
   machine with a browser and paste the token back).

### Archival snapshots

The remote retention sweep is scoped to `badminton-*.dump`, matching the local
one. Anything named differently — `pre-rework-*.dump`, say — is kept
indefinitely on both sides. Park one-off point-in-time copies under a distinct
name and neither sweep will reap them.
