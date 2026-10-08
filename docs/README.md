# `docs/`

Everything written down about the club app, grouped by who needs it.

Start with [`project/`](project/README.md) if you're new. It's the
plain-language overview and needs no engineering background.

---

## `project/`: the executive overview

Written for the exec team. What the app is, what's built, what's planned, how
members' data and the club's money are protected, and the stack a technical
successor inherits.

Read [`project/README.md`](project/README.md) first; it indexes the numbered
documents.

## `guides/`: for the people using the app

| Document | For |
|----------|-----|
| [`admin-guide.md`](guides/admin-guide.md) | Running the club from the console. Non-technical. |
| [`player-faq.md`](guides/player-faq.md) | What a member needs to know. |

## `design/`: proposals and specs

Design documents describing intent. **Check a design doc's status line against
the code before trusting it.** Some describe things since built, and some
describe things never built.

- [`discord-bot.md`](design/discord-bot.md): command and permission spec. Its
  header says the bot is built; the document is kept as the design record, not
  a description of the code ([`apps/bot`](../apps/bot/README.md) is).
- [`discord-bot-plan.md`](design/discord-bot-plan.md): rollout plan.
- [`exec-portfolios.md`](design/exec-portfolios.md): the proposed
  per-portfolio permission model. Not built as written. The console kept the
  four-level access model in `apps/admin/src/lib/console-access.ts` and added
  per-officer permissions on top: a `permission_role`, grant and revoke lists
  and permission baselines (migration 00087 onward), edited on the console's
  `/permissions` screen.

## `legal/`: club policies

The club's policy drafts live in `legal/`. The app serves the text members
actually accept from the database (`legal_documents`), not from those files.
None of it has had review by anyone with legal standing.

---

## Not in this directory

- **`docs/sensitive/`** is gitignored and is not in the repository. Anything
  linking to it will not resolve on a fresh clone; that is deliberate, since
  this repo is public.
- **Error codes**: [`packages/shared/ERROR-CODES.md`](../packages/shared/ERROR-CODES.md)
  says what each code on an error screen or toast means.
- **Code-level documentation** lives next to the code, in each part's own
  README: [`apps/player`](../apps/player/README.md) ·
  [`apps/admin`](../apps/admin/README.md) · [`apps/bot`](../apps/bot/README.md) ·
  [`packages/shared`](../packages/shared/README.md) ·
  [`packages/ui`](../packages/ui/README.md) ·
  [`supabase`](../supabase/README.md).
