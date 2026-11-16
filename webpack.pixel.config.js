/* Webpack config for the pixel-consistency harness.
 * Builds the SAME test/support/pixelHarnessEntry.js twice:
 *   side=baseline -> from the pristine git HEAD tree at
 *                    artifacts/svg-export/pixel/baseline-src
 *   side=patched  -> from the current working tree
 * Both bundles are then rendered headlessly and compared byte for byte. */
const path = require('path');
const webpack = require('webpack');

module.exports = (env = {}) => {
  const side = env.side || 'patched';
  const context = side === 'baseline'
    ? path.resolve(__dirname, 'artifacts/svg-export/pixel/baseline-src')
    : __dirname;
  return {
    mode: 'development',
    context,
    entry: './test/support/pixelHarnessEntry.js',
    output: {
      path: path.resolve(__dirname, `artifacts/svg-export/pixel/${side}-build`),
      filename: 'pixel.bundle.js',
      publicPath: './'
    },
    module: {
      rules: [
        { test: /\.js$/, use: 'babel-loader', exclude: /node_modules/ },
        { test: /\.glsl$/, use: 'raw-loader' },
        { test: /\.woff2?$/, use: 'url-loader?limit=10000&mimetype=application/font-woff' },
        { test: /\.otf$/, use: 'file-loader' },
        { test: /\.ttf$/, use: 'file-loader' },
        { test: /\.eot$/, use: 'file-loader' },
        { test: /\.svg$/, use: 'url-loader' },
        { test: /\.html$/, use: 'html-loader' },
        { test: /\.css$/, use: 'style-loader!css-loader' },
        { test: /\.png$/, use: 'url-loader' }
      ]
    },
    plugins: [
      new webpack.DefinePlugin({ __DEBUG__: true, __HIDE_DATA__: false })
    ]
  };
};
