/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const path = require('path');

const nextConfig = {
  output: 'standalone',
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
  });
} else {
  module.exports = nextConfig;
}
