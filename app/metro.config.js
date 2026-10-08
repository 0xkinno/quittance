/**
 * Metro configuration.
 *
 * The app lives in a pnpm workspace and imports `@quittance/engine` from a
 * sibling package, so Metro has to be told to watch outside this directory and
 * to resolve symlinked workspace packages.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm's store is symlink-heavy; without this Metro resolves a package to its
// link rather than its real path and then fails to find its dependencies.
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = true;

// Metro does not honour package "exports" subpaths by default, and
// mobile-wallet-adapter-protocol-web3js requires "…/protocol/encoding".
// Map just that one subpath rather than enabling exports for every package.
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@solana-mobile/mobile-wallet-adapter-protocol/encoding') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(
        projectRoot,
        'node_modules/@solana-mobile/mobile-wallet-adapter-protocol/lib/cjs/encoding.native.js',
      ),
    };
  }
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
