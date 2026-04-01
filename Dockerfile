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
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST

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
