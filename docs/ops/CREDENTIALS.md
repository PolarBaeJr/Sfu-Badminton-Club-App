# Credentials & Custody

The single most important handover document. When execs graduate, **access** is what gets lost — not code. This tracks *who holds what* and *how to recover it*.

> 🔒 **This repo is public. Do NOT write real passwords, keys, tokens, or private hostnames in this file.** Fill in the actual values in the club **password manager** (a shared vault) and keep this file as a **map** — asset, owner, and where the real value lives. If you need a filled-in copy, keep it private (password manager or an uncommitted local file).

---

## How to use this

1. Create a shared **password manager vault** for the club (e.g. Bitwarden/1Password org, or a shared Proton Pass). This is the source of truth for secret values.
2. Fill in the **Owner** and **Vault entry** columns below (not the secrets themselves).
3. At every exec transition, transfer vault access and update the Owner column.
4. Confirm **recovery** works for each item *before* the current owner leaves.

---

## Custody register

| # | Asset | What it's for | Owner (fill in) | Where the secret lives | Recovery method |
|---|-------|---------------|-----------------|------------------------|-----------------|
| 1 | **Domain name** | The club's web address | | Registrar account (vault) | Registrar account recovery / email |
| 2 | **Server (Raspberry Pi)** | Hosts the app + database | | SSH key + host in vault | Physical access to the device |
| 3 | **SSH key** | Access to the server | | Vault (private key file) | Re-key from the physical device |
| 4 | **GitHub org / repo** | Source code + CI | | GitHub account (vault) | GitHub account recovery + org owner |
| 5 | **GHCR (container registry)** | Built app images | | Tied to GitHub | Via GitHub |
| 6 | **Supabase self-host keys** | DB anon + service-role keys | | Server `.env` + vault | Regenerate on the self-hosted stack |
| 7 | **Postgres / DB access** | Direct database access | | Server (in-container) | Via server access |
| 8 | **Google OAuth client** | "Sign in with Google" | | Google Cloud Console (vault) | Google account + project owner |
| 9 | **Resend (email)** | Sending club email | | Resend account (vault) | Resend account recovery |
| 10 | **VAPID keys** | Web push notifications | | Server env + vault | Regenerate (invalidates existing subs) |
| 11 | **Sentry** | Error monitoring | | Sentry account (vault) | Account recovery |
| 12 | **PostHog** | Analytics | | PostHog account (vault) | Account recovery |
| 13 | **Backup storage (Google Drive)** | Off-site encrypted backups | | Google account (vault) | Account recovery |
| 14 | **Backup encryption password** | Decrypts off-site backups | | **Vault only** (critical) | ⚠️ No recovery if lost — backups become unreadable |
| 15 | **Reverse-proxy dashboard token** | Manual deploy control | | Vault | Re-mint from the dashboard UI |
| 16 | **`CRON_SECRET`** | Guards scheduled jobs | | Supabase secrets + vault | Rotate via `supabase secrets set` |

*(Add rows as new services are introduced — e.g. Stripe when online payments ship.)*

---

## Critical warnings

- **#14 (backup encryption password)** has **no recovery**. If it's lost, every off-site backup is permanently unreadable. Store it in the vault *and* one trusted secondary location.
- **#6 (service-role key)** can read/write the entire database and bypass all protections. Treat it like the master key. It must stay server-side only.
- Rotating **#10 (VAPID)** invalidates all existing push subscriptions (members re-subscribe automatically on next visit).

---

## Handover checklist (do this at every exec transition)

- [ ] New technical exec added to the password-manager vault.
- [ ] New exec added as a **GitHub org owner** and can push + merge.
- [ ] New exec can **SSH into the server** and run `docker ps`.
- [ ] New exec can log into the **reverse-proxy dashboard**.
- [ ] New exec has done **one supervised deploy** end-to-end.
- [ ] New exec has done **one supervised backup restore** (into a scratch DB).
- [ ] Domain, Google, Resend, Supabase, backup accounts all transferred or shared.
- [ ] Departing exec's personal access removed **after** the above is confirmed.
- [ ] This table's **Owner** column updated.

---

## Related

- Deploy / restore / secrets procedures: [RUNBOOK.md](RUNBOOK.md)
- Backup setup: `backup/README.md`
- Edge-function secrets: `supabase/functions/DEPLOY.md`
