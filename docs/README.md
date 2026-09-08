# `docs/`

Everything written down about the club app, grouped by who needs it.

Start with [`project/`](project/README.md) if you're new — it's the
plain-language overview and needs no engineering background.

---

## `project/` — the executive overview

Written for the exec team. What the app is, what's built, what's planned, how
members' data and the club's money are protected, what it costs to run, and the
stack a technical successor inherits.

Read [`project/README.md`](project/README.md) first; it indexes the six numbered
documents.

## `ops/` — running it in production

| Document | For |
|----------|-----|
| [`RUNBOOK.md`](ops/RUNBOOK.md) | Step-by-step production procedures, written for a successor who has never touched it. **The first thing to read before doing anything to the live system.** |
| [`CREDENTIALS.md`](ops/CREDENTIALS.md) | Who holds what access and how to recover it. The handover document — when execs graduate, access is what gets lost, not code. |
| [`rate-limits.md`](ops/rate-limits.md) | Rate limiting happens at the edge, in the proxy, not in the app. This is the only record in the repo of what those limits are. |
| [`audit-policy.md`](ops/audit-policy.md) | What the audit trail actually guarantees, so the promise and the code agree. |
| [`discord-bot-bringup.md`](ops/discord-bot-bringup.md) | The steps for the bot that *cannot* be done from a code change — Developer Portal settings, tokens, role positions. |

## `guides/` — for the people using the app

| Document | For |
|----------|-----|
| [`admin-guide.md`](guides/admin-guide.md) | Running the club from the console. Non-technical. |
| [`player-faq.md`](guides/player-faq.md) | What a member needs to know. |

## `design/` — proposals and specs

Design documents describing intent. **Check a design doc's status line against
the code before trusting it** — some describe things since built, and some
describe things never built.

- [`discord-bot.md`](design/discord-bot.md) — command and permission spec.
  ⚠️ Its header still says "specified, not built"; the bot exists and runs
  ([`apps/bot`](../apps/bot/README.md)).
- [`discord-bot-plan.md`](design/discord-bot-plan.md) — rollout plan.
- [`exec-portfolios.md`](design/exec-portfolios.md) — the proposed
  per-portfolio permission model. Not built; the console still uses the
  four-level access model in `apps/admin/src/lib/console-access.ts`.

## `legal/` — drafts

[`privacy-policy.md`](legal/privacy-policy.md) ·
[`terms-of-use.md`](legal/terms-of-use.md) ·
[`code-of-conduct.md`](legal/code-of-conduct.md) ·
[`liability-waiver.md`](legal/liability-waiver.md)

These are the documents the app serves under `/legal` and gates sign-up on.
They are **drafts** and have not had legal review.

## `STAGING.md`

The second full copy of the app running alongside production, with its own
database, at `badminton.polardev.org`. Production is never touched by anything
done there — and equally, nothing done there survives the 04:00 refresh.

---

## Not in this directory

- **`docs/sensitive/`** — internal working notes and security findings. It is
  **gitignored** and is not in the repository. Anything linking to it will not
  resolve on a fresh clone; that is deliberate, since this repo is public.
- **Code-level documentation** lives next to the code, in each part's own
  README: [`apps/player`](../apps/player/README.md) ·
  [`apps/admin`](../apps/admin/README.md) · [`apps/bot`](../apps/bot/README.md) ·
  [`packages/shared`](../packages/shared/README.md) ·
  [`packages/ui`](../packages/ui/README.md) ·
  [`supabase`](../supabase/README.md) · [`scripts`](../scripts/README.md) ·
  [`backup`](../backup/README.md).
