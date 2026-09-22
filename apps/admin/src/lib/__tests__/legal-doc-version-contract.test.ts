import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The legal documents exist TWICE: as prose in docs/legal/*.md, and as the
 * `content` column of `legal_documents`, seeded inline in a migration. The
 * database copy is the one that matters, because that is what the app shows and
 * what a member's row in `waiver_acceptances` refers to.
 *
 * Nothing binds the two together. The markdown carries an "Effective date"
 * written by hand, and both files sat on a literal `[DATE]` placeholder for
 * months while all 39 members had already accepted version '2026-07-19'.
 *
 * The failure this prevents is not cosmetic. Access is gated on the version
 * string: `legal_documents.version` is compared against what the member
 * accepted, and a mismatch forces re-acceptance. So an effective date in the
 * published prose that disagrees with the seeded version is a document nobody
 * has agreed to, which is the one property a consent record exists to provide.
 *
 * Parsed from source on both sides on purpose. The seeded content is inside a
 * dollar-quoted SQL literal, so it cannot be imported; and these tests do not
 * reach a database, so the live row cannot be read either.
 */

const REPO = join(__dirname, '../../../../..');

/** document key in `legal_documents` -> the markdown that publishes it */
const DOCUMENTS: Record<string, string> = {
  terms_of_use: 'docs/legal/terms-of-use.md',
  privacy_policy: 'docs/legal/privacy-policy.md',
};

/**
 * BOTH seed migrations, because the four documents are split across them:
 * 00010 ships `waiver` and `code_of_conduct`, 00014 adds `terms_of_use` and
 * `privacy_policy`. Reading only 00014 makes the coverage check below silently
 * vacuous, which is how this test failed the first time it was run.
 */
const SEED = [
  'supabase/migrations/00010_waivers.sql',
  'supabase/migrations/00014_legal_docs_expand.sql',
].map((p) => readFileSync(join(REPO, p), 'utf8')).join('\n');

/**
 * The seed row is `('<document>', '<version>', $tag$...`. Matching only as far
 * as the version keeps this off the content, which is long, dollar-quoted and
 * full of the same punctuation.
 */
function seededVersion(document: string): string | null {
  const m = new RegExp(`\\('${document}',\\s*'([0-9]{4}-[0-9]{2}-[0-9]{2})'`).exec(SEED);
  return m?.[1] ?? null;
}

/** The `**Effective date:** 2026-07-19` line, which is what a reader sees. */
function publishedEffectiveDate(path: string): string | null {
  const md = readFileSync(join(REPO, path), 'utf8');
  const m = /^\*\*Effective date:\*\*\s*`?([0-9]{4}-[0-9]{2}-[0-9]{2})`?\s*$/m.exec(md);
  return m?.[1] ?? null;
}

describe('legal document versions agree between the seed and the published prose', () => {
  for (const [document, path] of Object.entries(DOCUMENTS)) {
    it(`${document} carries a real date, not a placeholder`, () => {
      const published = publishedEffectiveDate(path);
      expect(
        published,
        `${path} has no parseable "**Effective date:** YYYY-MM-DD" line. A ` +
        `placeholder like [DATE] fails here deliberately: it means the club ` +
        `published a policy with no stated effective date.`,
      ).not.toBeNull();
    });

    it(`${document} matches the version seeded into legal_documents`, () => {
      const seeded = seededVersion(document);
      expect(seeded, `no seeded version found for ${document}`).not.toBeNull();

      expect(
        publishedEffectiveDate(path),
        `${path} states an effective date that is not the version in ` +
        `legal_documents. Access is gated on that version, so these ` +
        `disagreeing means members accepted a different document than the one ` +
        `published. Change both, and remember that changing the version is ` +
        `what forces every member to re-accept.`,
      ).toBe(seeded);
    });
  }

  it('covers every document the seed actually inserts', () => {
    const seeded = [...SEED.matchAll(/\('([a-z_]+)',\s*'[0-9]{4}-[0-9]{2}-[0-9]{2}'/g)]
      .flatMap((m) => (m[1] ? [m[1]] : []));

    // code_of_conduct and waiver ARE seeded, and docs/legal does carry a file
    // for each, but neither states an "Effective date" line to compare against.
    // Listing them explicitly keeps that a knowing gap: if a third document
    // gains a version it will land here and fail, rather than being skipped.
    const unmapped = seeded.filter((d) => !(d in DOCUMENTS));
    expect(unmapped.sort()).toEqual(['code_of_conduct', 'waiver']);
  });
});
