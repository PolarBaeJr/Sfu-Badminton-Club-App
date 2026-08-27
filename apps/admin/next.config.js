/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

// Single source of truth for the version shown in Settings > About. It used to
// be a literal in that page and drifted to a year-stale "v0.0.1"; reading the
// workspace root here means the only way to change it is to bump the manifest.
const appVersion = require('../../package.json').version;

const path = require('path');

const nextConfig = {
  output: 'standalone',
  // Pin the tracing root to the workspace. Left to infer it, Next walks up
  // looking for lockfiles and can land outside the repo entirely (a stray
  // ~/package-lock.json is enough), which decides what gets copied into the
  // standalone bundle the container runs.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Inlined at build time, so the standalone server needs nothing at runtime.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // The console is served at sfubadminton.com/admin — the player app's own
  // origin. It used to have a subdomain, but the player app is an installed
  // PWA, and a PWA cannot keep a cross-origin navigation in its window: every
  // tap of "Exec Panel" ejected the exec into a browser tab.
  //
  // Env-driven rather than a literal because basePath is baked in at BUILD
  // time and localhost still wants a root-mounted console. `undefined` rather
  // than '' when unset, so an unset build resolves to exactly Next's default.
  // Everything that has to follow this prefix by hand — fetch(), raw
  // window.location, redirectTo — lives in src/lib/base-path.ts.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // src/instrumentation.ts (Sentry server/edge init) needed an experimental
  // flag on 14; it is default-on from 15, and leaving the flag set now only
  // earns an "unrecognised experimental option" warning.
  transpilePackages: ['@badminton/shared', '@badminton/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

// Only wrap with Sentry when DSN is configured
if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const { withSentryConfig } = require('@sentry/nextjs');
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    silent: !process.env.CI,
    widenClientFileUpload: true,
    tunnelRoute: '/monitoring',
    hideSourceMaps: true,
    disableLogger: true,

    // Tree-shake Sentry code we never execute. Session Replay is sampled at 0
    // in sentry.client.config.ts and replayIntegration is not registered, so
    // its rrweb payload was being shipped and parsed for nothing. Note the
    // installed SDK has no excludeReplayShim flag, so this trims replay but
    // cannot remove it outright. Tracing stays in (we use it).
    bundleSizeOptimizations: {
      excludeDebugStatements: true,
      excludeReplayIframe: true,
      excludeReplayShadowDom: true,
      excludeReplayWorker: true,
    },
  });
} else {
  module.exports = nextConfig;
}
