module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated's plugin rewrites worklets and must be last in the list.
    plugins: ['react-native-reanimated/plugin'],
  };
};
