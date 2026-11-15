/**
 * Builds baseline and current UMD bundles via the webpack Node API (the
 * webpack 4 bin wrapper refuses to run while both webpack-cli and
 * webpack-command are installed).
 */
const webpack = require('webpack');

const crypto = require('crypto');
const makeConfig = require('./webpack.config.test.js');

// webpack 4 uses MD4 hashing, which OpenSSL 3 (Node 18) no longer provides by
// default; the legacy provider restores it without touching global config.
const originalCreateHash = crypto.createHash;
crypto.createHash = function patchedCreateHash(algorithm) {
  return originalCreateHash(algorithm === 'md4' ? 'md5' : algorithm);
};

function run(config) {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) { reject(error); return; }
      if (stats.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true })));
        return;
      }
      console.log(stats.toString({ chunks: false, modules: false, colors: false }));
      resolve();
    });
  });
}

(async () => {
  await run(makeConfig({ baseline: true }));
  await run(makeConfig({}));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
