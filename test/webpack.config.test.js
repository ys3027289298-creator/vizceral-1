const path = require('path');
const webpack = require('webpack');

// Builds a UMD bundle of either the current sources or a baseline snapshot,
// plus the in-browser test driver. Run with --env.baseline=true for baseline.
module.exports = (env = {}) => ({
  mode: 'development',
  devtool: false,
  entry: env.baseline
    ? path.resolve(__dirname, 'baseline-src/vizceral.js')
    : path.resolve(__dirname, '../src/vizceral.js'),
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: env.baseline ? 'vizceral-baseline.js' : 'vizceral-current.js',
    library: 'Vizceral',
    libraryTarget: 'umd',
    umdNamedDefine: true
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            babelrc: false,
            presets: [['env', { targets: { chrome: '80' } }]]
          }
        }
      },
      { test: /\.glsl$/, use: 'raw-loader' },
      { test: /\.woff2?$/, use: 'url-loader?limit=10000&mimetype=application/font-woff' },
      { test: /\.otf$/, use: 'file-loader' },
      { test: /\.ttf$/, use: 'file-loader' },
      { test: /\.eot$/, use: 'file-loader' },
      { test: /\.svg$/, use: 'url-loader' },
      { test: /\.png$/, use: 'url-loader?limit=10000' },
      { test: /\.css$/, use: 'style-loader!css-loader' }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      __DEBUG__: true,
      __HIDE_DATA__: false
    })
  ]
});
