# 6 · Tech Stack

*The technologies the app is built on. Useful for a technical successor (exec handover) and for anyone evaluating the project. The plain-language "why it matters" is for everyone else.*

**Plain version:** it's a modern TypeScript web app (Next.js + React) with a Supabase/PostgreSQL backend, packaged with Docker. All mainstream, well-supported, hireable technologies: nothing exotic that only one person can maintain.

---

## At a glance

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript 5.5 |
| **Framework** | Next.js 15.5 (App Router, standalone output) + React 19.2 |
| **Styling** | Tailwind CSS 3.4, Radix UI primitives, lucide-react icons, Framer Motion |
| **Backend / database** | Supabase: PostgreSQL 17, Auth, REST, Storage, Realtime |
| **Serverless jobs** | Supabase Edge Functions (Deno runtime) |
| **Validation** | Zod 3 |
| **Email / push** | Resend (email), web-push / VAPID (notifications) |
| **Monorepo tooling** | npm workspaces + Turborepo 2 |
| **Testing / quality** | Vitest 4, ESLint 8, TypeScript type-checking |
| **Monitoring** | Sentry (errors), PostHog (analytics) |
| **Runtime / packaging** | Node 24, Docker (multi-stage) |

---

## Detail

### Frontend
- **Next.js 15.5.22** — React framework, using the App Router and **server actions** (form/data logic runs securely on the server). Built in **standalone** mode for lean Docker images.
- **React 19.2**. Pinned to a single copy by root `overrides`; `packages/ui` takes react as a *peer* dependency. Two copies in one tree cause React error #31 at runtime.
- **Tailwind CSS 3.4** for styling, with PostCSS + Autoprefixer. Helpers: `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`.
- **Radix UI** primitives + **shadcn**-style components for accessible UI building blocks.
- **lucide-react** icon set; **Framer Motion** for animation (player app).
- Installable **PWA** with a service worker (offline shell, push notifications).

### Backend & data
- **Supabase** (the open-source stack, which runs self-hosted or on Supabase Cloud):
  - **PostgreSQL 17** database.
  - **Auth** (email code + Google OAuth).
  - **PostgREST** auto-API + **Row-Level Security** for data protection.
  - **Storage**, **Realtime**, and a **Kong** API gateway.
  - Client libraries: `@supabase/supabase-js` v2 + `@supabase/ssr` (server-side auth).
- **Edge Functions** run on **Deno** for scheduled/background jobs (reminders, expiries, season snapshots, no-show detection).
- **Zod** validates all input against strict schemas.

### Shared code (monorepo packages)
- **`shared`** — the **ELO rating engine**, Zod validators, email templates (Resend), and push senders (web-push). One source of truth used by both apps.
- **`ui`** — ~two dozen reusable interface components.
- **`config`** — shared configuration.
- **`apps/player`** and **`apps/admin`** — the two Next.js applications.

### Notifications & integrations
- **Resend** — transactional email (login codes, reminders, announcements) with branded templates.
- **web-push (VAPID)** — browser/phone push notifications.
- **jsPDF** — PDF generation (admin).

### Quality & monitoring
- **Vitest 4** — automated tests (including the rating engine).
- **ESLint 8** + `eslint-config-next` — code linting.
- **TypeScript** type-checking across the monorepo.
- **Sentry** — error tracking. **PostHog** — product analytics.

### Build & packaging
- **npm 11 workspaces** + **Turborepo 2** orchestrate the monorepo builds.
- **Node 24 (LTS)** everywhere: pinned once in `.nvmrc` and mirrored by `engines.node` and the Dockerfile.
- **Docker**: multi-stage builds on `node:24-bookworm-slim`, producing separate player, admin and bot images.

---

## Why this stack

- **Mainstream and hireable** — Next.js, React, TypeScript, PostgreSQL, and Docker are among the most widely-used tools in the industry. A future exec or hired developer can pick it up.
- **Portable**: built on open-source Supabase and standard containers, so the club isn't locked into any vendor and can move it anywhere.
- **Type-safe end to end** — TypeScript + Zod catch errors before they reach users.
- **Cheap to run**: open-source components with no per-seat licences.

*See also: [04-security.md](04-security.md).*
