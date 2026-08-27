/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // camera=(self), not camera=(). This app scans QR codes in-browser — the
  // session check-in button and the tournament door scanner both call
  // getUserMedia — and `camera=()` is a platform-level veto that denies them
  // before the user is ever asked. It shipped that way, which means the
  // tournament in-app scanner has been dead on Chrome/Android since it landed;
  // Safari's thinner Permissions-Policy support is why an iPhone-heavy club
  // never reported it.
  //
  // `self` grants nothing: the browser still prompts and the member still has
  // to allow it. It only restores our own origin's right to ask. Third parties
  // remain excluded, and nothing can frame us anyway (X-Frame-Options: DENY).
  // microphone and geolocation stay fully denied.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

// Read from the workspace root, the same source the admin console uses, so one
// manifest bump moves both apps. The settings page used to hard-code this and
// sat at a year-stale "0.0.1" through every release since.
const appVersion = require('../../package.json').version;

const path = require('path');

const nextConfig = {
  output: 'standalone',
  // Inlined at build time, so the standalone server needs nothing at runtime.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // Pin the tracing root to the workspace. Left to infer it, Next walks up
  // looking for lockfiles and can land outside the repo entirely (a stray
  // ~/package-lock.json is enough), which decides what gets copied into the
  // standalone bundle the container runs.
  outputFileTracingRoot: path.join(__dirname, '../..'),
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
