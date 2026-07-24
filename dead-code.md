# Dead-code audit

Generated with `knip` (unused files / exports / deps), then **curated by hand** —
knip doesn't know about Deno edge functions, the service worker, or generated
files, so its raw output has false positives. Tiers below reflect verification.

To reproduce: `npx knip@5 --no-progress` from the repo root.

---

## Tier 1 — Safe to delete (verified unreferenced)

Confirmed with grep that nothing imports these.

**Files**
- `apps/player/src/components/ErrorBoundary.tsx`
- `apps/admin/src/components/ErrorBoundary.tsx`
- `apps/player/src/components/ui/card.tsx`
- `apps/player/src/components/ui/input.tsx`
- `apps/player/src/components/ui/label.tsx`
- `apps/player/src/components/ui/separator.tsx`
  - ^ shadcn scaffolding leftovers, never imported.
- `apps/player/src/lib/env.ts` and `apps/admin/src/lib/env.ts`
  - Not imported anywhere. `env.ts` is the **only** consumer of `zod` in the
    player app — deleting it makes `zod` removable too (see deps).

**Unused dependencies** (remove from the listed `package.json`)
- `jspdf` — `apps/admin/package.json` (not referenced in admin src)
- `shadcn` — `apps/player/package.json` (it's a CLI/devtool, never a runtime import)
- `tw-animate-css` — `apps/player/package.json` (not referenced)
- `zod` — `apps/player/package.json` (only used by `lib/env.ts`, itself dead)

**Unused exports** (delete the export; likely shadcn/scaffolding)
- `buttonVariants` — `apps/player/src/components/ui/button.tsx:67` (verify the
  `button.tsx` component itself is still used before trimming just this export)

---

## Tier 2 — Very likely dead, but eyeball before deleting

These are unused per knip and look like scaffolding/WIP, but confirm they aren't
wired via a route you know is unfinished.

- `apps/admin/src/app/tournaments/[id]/bracket.tsx`
- `apps/admin/src/app/tournaments/[id]/participants.tsx`
  - Not imported by the tournament page. Could be WIP tournament UI.
- `packages/shared/src/push/vapid.ts` — check no **edge function** uses it
  (knip ignores `supabase/functions/**`, so verify by grepping that dir).
- `apps/player/src/components/motion-wrapper.tsx` → `StaggerContainer`, `StaggerItem`
- `apps/player/src/lib/posthog.ts` → `trackEvent`
- `apps/admin/src/lib/permissions.ts` → `SECTION_ACCESS`
- `apps/admin/src/lib/passkey/cookie.ts` → `PasskeyCookiePayload` (type)

**Admin tournament write-actions — unused per knip (a whole feature may be unwired):**
- `apps/admin/src/lib/tournament-actions.ts` barrel + underlying fns:
  `updateTournamentEvent`, `deleteTournamentEvent`, `withdrawParticipant`,
  `disqualifyParticipant`, `editMatchResult`, `applyPlacementBonuses`
- `apps/admin/src/lib/actions/tournaments.ts` → `addTournamentParticipant`,
  `removeTournamentParticipant`
- `apps/admin/src/lib/supabase-server.ts` → `createServerSupabaseClient`
  - Surprising it's unused in admin — **verify** admin isn't calling it before removing.
  - ⚠️ These may be intentionally-not-yet-wired admin features. Don't bulk-delete;
    decide per-item whether the feature is dropped or pending.

---

## Tier 3 — DO NOT DELETE (knip false positives)

knip flagged these because it isn't configured for their entry-point type.

- `supabase/functions/**` (all of them) — **Deno edge functions**, deployed
  separately and invoked by cron/schedules. Not imported by the Next apps by design.
- `apps/player/public/sw.js`, `apps/admin/public/sw.js` — service workers,
  registered at runtime, never imported.
- `scripts/generate-pwa-icons.mjs` — manual build script.
- `packages/config/tailwind.config.ts` — consumed by Tailwind tooling, not imported.
- `packages/shared/src/types/database.gen.ts` → `Constants`, `Tables`,
  `TablesInsert`, `TablesUpdate`, `Enums`, `CompositeTypes` — **generated file**;
  leave as-is (regenerated from the DB schema).

---

## Correctness fixes worth doing (not deletions)

- `packages/ui/src/components/RouteError.tsx` imports `lucide-react` but
  `packages/ui/package.json` doesn't list it — relies on hoisting. **Add
  `lucide-react` to `packages/ui` dependencies** so it doesn't break under strict
  installs. (Pre-existing, unrelated to this session.)

---

## Suggested approach

Do Tier 1 in one commit (files + deps together, run `npm install` to update the
lockfile, then `tsc` both apps). Triage Tier 2 per-item. Skip Tier 3 entirely.
After removing deps, re-run `npx knip` to confirm the graph is clean.
