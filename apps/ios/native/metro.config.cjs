const path = require('node:path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const repository = path.resolve(__dirname, '../../..');
const workspaceModules = {
  '@openpane/theme': path.join(repository, 'packages/theme'),
  '@openpane/ui-primitives': path.join(repository, 'packages/ui-primitives'),
};

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [path.resolve(__dirname, '../src'), ...Object.values(workspaceModules)],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    extraNodeModules: workspaceModules,
  },
});
