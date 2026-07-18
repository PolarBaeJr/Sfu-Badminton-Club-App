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
