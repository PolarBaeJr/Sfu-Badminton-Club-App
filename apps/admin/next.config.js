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

const nextConfig = {
  output: 'standalone',
  // Inlined at build time, so the standalone server needs nothing at runtime.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // No basePath: the admin console has its own subdomain
  // (admin.sfubadminton.com) and serves from the root. It previously lived at
  // sfubadminton.com/admin, which is why asset and cookie paths below were
  // prefixed — those moved with it.
  // Required in Next 14 for src/instrumentation.ts (Sentry server/edge init) to
  // run; default-on in Next 15.
  experimental: { instrumentationHook: true },
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
  });
} else {
  module.exports = nextConfig;
}
