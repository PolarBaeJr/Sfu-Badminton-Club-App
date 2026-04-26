# Whole-Codebase Refactor — Plan

Branch: `deploy/docker-dev`. Executing all four angles, in this order:

## Phase R1 — Generated DB types (highest leverage)

Goal: kill `as Record<string, unknown>` / `as any` chains around Supabase
queries by piping through generated types. Catches schema drift at
compile time.

Steps:
1. Run `supabase gen types typescript --workdir ~/ssd/Deploy/badminton-dev`
   on the Pi against the dev DB, output to
   `packages/shared/src/types/database.gen.ts` (gitignored — regen on demand).
2. Re-export `Database` from `packages/shared/src/types/index.ts`.
3. Update `createServerSupabaseClient`, `createClient`,
   `createServiceRoleClient` to typed `<Database>` clients in both
   apps and shared.
4. Spot-replace cast chains where types were obviously broken
   (player joins, ratings nesting). Don't try to retype every helper
   signature — let inference handle most.

Commit: `R1: generated DB types + typed Supabase clients`.

## Phase R2 — Split apps/player/src/lib/actions.ts

Currently 700+ lines, kitchen-sink. Split into:
- `actions/_shared.ts` — `requirePlayer`, `getPlayerProps`, `trackServerEvent`, posthog client
- `actions/challenges.ts` — create / accept / reject / cancel
- `actions/matches.ts` — submit / confirm / dispute / report walkover
- `actions/profile.ts` — updateProfile, completeOnboarding
- `actions/notifications.ts` — markNotificationRead / markAllNotificationsRead, markAnnouncementRead
- `actions/sessions.ts` — checkInToSession

Re-export everything from `lib/actions.ts` so existing call sites don't
move. Use `'use server'` per file.

Commit: `R2: split actions.ts into per-domain modules`.

## Phase R3 — Extract reusable components

Pull the inline-style blobs from the redesigned pages into proper React
components in `packages/ui/src/components/`. Targets:
- `<PageHeader eyebrow title sub action />`
- `<Section title count>{children}</Section>`
- `<StatBlock label value sub />`
- `<DataRow leading title sub trailing />`
- `<AvatarChip name id size>`
- `<EmptyState icon>{children}</EmptyState>`

Replace ~40 inline-style call sites across feed / leaderboard /
my-stats / challenges / sessions / announcements / tournaments /
notifications / settings / login / onboarding.

Commit: `R3: extract layout primitives and replace inline styles`.

## Phase R4 — error.tsx + loading.tsx per route

The code review flagged ~9 / 40 routes have these. Add a generic
`<RouteError>` and `<RouteLoading>` skeleton in
`packages/ui/src/components/`, then wrap each missing route.

Commit: `R4: add error/loading states to remaining routes`.

---

## Out of scope (intentionally deferred)

- Push-notification real impl (M1) — needs VAPID keys, runtime work.
- Pagination on lists (M5) — needs design decisions on cursor vs offset.
- Tournament admin UI rewrite — admin app deliberately skipped this session.
- Replacing radix/shadcn primitives — they're working; not worth the churn.
- React.memo / useMemo passes (m7 from review) — taste-not-correctness;
  defer unless profiling says otherwise.

Each phase commits independently. If any phase blocks, the prior
commits stand on their own.
