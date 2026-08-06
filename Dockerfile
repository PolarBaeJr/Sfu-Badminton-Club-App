# ---- Stage 1: Install dependencies ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/player/package.json apps/player/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/

RUN npm ci

# ---- Stage 2: Build both apps ----
FROM deps AS builder
WORKDIR /app

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PLAYER_URL
ARG NEXT_PUBLIC_ADMIN_URL
# Mount point for the admin console — see apps/admin/next.config.js. Empty (the
# default) builds today's subdomain image; "/admin" builds the second image that
# the proxy serves from sfubadminton.com/admin, so the player PWA can open the
# console without a cross-origin navigation throwing the exec out of the app.
# basePath is baked in at build time; this cannot be a runtime setting.
ARG NEXT_PUBLIC_BASE_PATH
# Where the player app's "Exec Panel" links point. Set to "/admin" once the
# path-mounted console is deployed; unset keeps the old NEXT_PUBLIC_ADMIN_URL
# behaviour. Player image only.
ARG NEXT_PUBLIC_ADMIN_PATH
# Passkey scope — see apps/admin/src/lib/passkey/config.ts. Must be the parent
# domain so one credential covers the apex and the admin subdomain.
ARG NEXT_PUBLIC_PASSKEY_RP_ID
# Auth cookie scope — see AUTH_COOKIE_DOMAIN in packages/shared. Set to
# ".sfubadminton.com" so one sign-in covers the player app and the admin
# console; leave EMPTY for a host-only cookie (the original behaviour, and the
# right answer on localhost). Build-time only: the browser writes this cookie
# too, so the value must be inlined into the client bundle — putting it in the
# runtime .env alone has no effect.
ARG NEXT_PUBLIC_AUTH_COOKIE_DOMAIN
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
# Build-only: let @sentry/nextjs upload source maps for readable stack traces.
# withSentryConfig reads SENTRY_ORG/SENTRY_PROJECT (next.config.js) and picks up
# SENTRY_AUTH_TOKEN from the env. Empty => upload is skipped, build still passes.
# These live only in this (unpublished) builder stage, not the runner images.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN

RUN npx turbo run build --filter=player --filter=admin --concurrency=1

# ---- Stage 3: Player runner ----
FROM node:20-bookworm-slim AS runner-player
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nextjs /app/apps/player/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/player/.next/static ./apps/player/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/player/public ./apps/player/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/player/server.js"]

# ---- Stage 4: Admin runner ----
FROM node:20-bookworm-slim AS runner-admin
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nextjs /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/admin/.next/static ./apps/admin/.next/static

USER nextjs
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
