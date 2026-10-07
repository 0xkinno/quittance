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

module.exports = config;
