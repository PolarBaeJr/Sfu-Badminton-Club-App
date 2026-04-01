# Deployment Changes

## Modified Files

- **`apps/player/next.config.js`** — added `output: 'standalone'` for Docker builds
- **`apps/admin/next.config.js`** — added `output: 'standalone'` + `basePath: '/admin'` for Docker builds and path-based routing
- **`apps/player/src/app/layout.tsx`** — added `export const dynamic = 'force-dynamic'` to prevent static prerendering (fails without Supabase at build time)
- **`apps/admin/src/app/layout.tsx`** — added `export const dynamic = 'force-dynamic'` (same reason)

## New Files

- **`Dockerfile`** — multi-stage build: installs deps, builds both apps with Turbo, produces separate runner images for player and admin
- **`docker-compose.yml`** — runs player (port 3000) and admin (port 3010) containers with env vars
- **`.dockerignore`** — excludes node_modules, .next, .git, etc. from Docker context
- **`.env.example`** — documents all required and optional environment variables

## OAuth Providers Configured

- Google
- Discord

## Known Issue

- `apps/admin/src/lib/actions.ts` line 13: `getAdminPlayer()` treats every logged-in user as admin (DEV MODE) — needs a proper role check before production use
