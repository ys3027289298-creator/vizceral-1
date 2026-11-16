/* Webpack config for the SVG-export test harness bundle.
 * Builds test/support/harnessEntry.js into artifacts/svg-export/build/.
 * Not part of the shipped library; dev-mode only. */
const path = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  entry: './test/support/harnessEntry.js',
  output: {
    path: path.resolve(__dirname, 'artifacts/svg-export/build'),
    filename: 'harness.bundle.js',
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
