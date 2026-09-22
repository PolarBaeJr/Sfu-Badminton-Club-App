# The live legal documents

These four files are exact copies of `legal_documents.content` on **production**,
exported 2026-09-22 and verified byte for byte by comparing `md5(content)` in the
database against the file. They are what members actually read and accept.

The markdown in the parent directory (`docs/legal/*.md`) is the older source those
documents were drafted from. The two have diverged in substance, not just in
wording, so do not treat the parent files as the current text. Where they differ,
these files are what is real.

## Editing

Edit these files. The diff is the change. Once you are happy with it the edits
become a migration that updates `legal_documents.content`, which is a production
write and therefore runs on your side, not here.

Two rules that are not style preferences:

- **Content and version move together.** All four documents are currently on
  version `2026-07-19`, and all 40 members are on record as having accepted that
  version. Changing the text without changing the version leaves everybody on
  record accepting a document that no longer exists. Changing the version is what
  forces re-acceptance.
- **Re-acceptance costs something, so batch it.** A version bump means all 40
  members must accept again before they can use the app. Make every change you
  want in one pass rather than trickling them out.

The app gates access on the version string, and
`apps/admin/src/lib/__tests__/legal-doc-version-contract.test.ts` pins the parent
directory's stated effective dates against the versions seeded in the migrations.

## Export detail

Each file ends with one trailing newline that `psql` adds and the database does
not contain. It is stripped when the migration is generated, so leave it alone.

Nothing automatically detects drift between these files and the database. If
somebody edits a document through Admin then Settings then Legal documents, these
files go stale silently. Re-export before editing if there is any doubt.

## Known items worth fixing while you are in here

Found by comparing the live text against what the app actually does:

1. **Backup retention is understated.** `privacy_policy.md` section 6 says
   encrypted backups are kept 14 days "and then deleted automatically". A deleted
   backup then sits in the storage provider's trash for roughly 30 further days.
   The text tells members their data is gone sooner than it is.
2. **Analytics is disclosed but is not running.** Section 4 covers "usage
   analytics". PostHog ships in the code but is switched off in production and
   collects nothing.
3. **No contact address anywhere.** All four documents say to contact a club
   executive. `privacy@sfubadminton.com`, `conduct@sfubadminton.com` and
   `exec@sfubadminton.com` exist and are routed, and a privacy policy with a
   dedicated contact point is worth more than one without.
4. **Service providers are not named.** Section 4 covers them in one sentence.
   The parent directory's version names Resend, Sentry, Discord, Google,
   Cloudflare and Google Drive along with what each one receives, which is better
   practice and is the version to lift from.
5. **`terms_of_use.md` dropped the under-19 clause** that the parent draft
   carries, even though the waiver still asks for guardian consent.

Still outstanding and not a wording fix: nobody with legal standing has read any
of this.
