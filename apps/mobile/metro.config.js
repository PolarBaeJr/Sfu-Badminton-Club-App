// Metro for an app that sits OUTSIDE the npm workspaces (see README.md) but
// imports source files from packages/shared.
//
// Everything resolves from apps/mobile/node_modules and nowhere else. The repo
// root's node_modules holds a different react (the web apps' override), and a
// second copy of react in the bundle fails at runtime, not at build time.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = { '@badminton/shared': sharedRoot };

// packages/shared/node_modules belongs to the web workspace install. Crawling
// it would offer Metro a second copy of every package shared depends on.
const sharedNodeModules = new RegExp(
  `^${path.join(sharedRoot, 'node_modules').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`,
);
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  sharedNodeModules,
];

// THE SHARED BARREL CANNOT BE BUNDLED FOR A PHONE. packages/shared/src/index.ts
// re-exports the email sender (resend); event-waiver and data-api-key use node
// crypto; web push is server-only. Deep imports of individual pure files are
// the only supported way in, and these are the paths a deep import must still
// never reach.
// src/__tests__/import-guard.test.ts checks the same list statically.
function forbiddenReason(context, moduleName) {
  if (moduleName === '@badminton/shared' || moduleName === '@badminton/shared/') {
    return 'the @badminton/shared barrel pulls in the email sender';
  }
  let target = null;
  if (moduleName.startsWith('@badminton/shared/')) {
    target = path.join(sharedRoot, moduleName.slice('@badminton/shared/'.length));
  } else if (
    moduleName.startsWith('.') &&
    context.originModulePath.startsWith(sharedRoot + path.sep)
  ) {
    target = path.resolve(path.dirname(context.originModulePath), moduleName);
  }
  if (target === null) return null;
  const rel = path.relative(sharedRoot, target).split(path.sep).join('/').replace(/\.tsx?$/, '');
  if (rel === 'src' || rel === 'src/index') {
    return 'the @badminton/shared barrel pulls in the email sender';
  }
  if (/^src\/(email|push)(\/|$)/.test(rel)) return `${rel} is server-only (email sender and web push)`;
  if (rel === 'src/utils/event-waiver') return `${rel} uses node crypto`;
  if (rel === 'src/utils/data-api-key') return `${rel} uses node crypto`;
  return null;
}

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const reason = forbiddenReason(context, moduleName);
  if (reason) {
    throw new Error(
      `apps/mobile cannot import "${moduleName}" (from ${context.originModulePath}): ${reason}. ` +
        'Import the individual pure file instead, e.g. @badminton/shared/src/utils/auth-otp.',
    );
  }
  return upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
