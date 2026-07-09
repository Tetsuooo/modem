const path = require('path');
const fs = require('fs');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Pages that must NOT be published to the live static site. admin.html is a
// tag-editing console whose save endpoints live in server.js (dev) / a future
// serverless fn — with no backend deployed it's a non-functional, only
// client-side-password-gated shell, so we keep it out of docs/. Re-enable by
// removing it here once a real authenticated write-back backend exists.
const DEV_ONLY_HTML = new Set(['admin.html']);

// Dynamically generate HtmlWebpackPlugin instances for each .html file in src/
const htmlFiles = fs
  .readdirSync(path.resolve(__dirname, 'src'))
  .filter(file => path.extname(file).toLowerCase() === '.html' && !DEV_ONLY_HTML.has(file))
  .map(file => new HtmlWebpackPlugin({
    filename: file,
    template: path.resolve(__dirname, 'src', file)
  }));

module.exports = {
  mode: 'production',
  entry: {}, // No JS entry needed for static site

  output: {
    path: path.resolve(__dirname, 'docs'),
    clean: true
  },

  resolve: {
    alias: {
      'pixi.js': 'pixi.js/dist/pixi.min.js',
    },
  },

  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false, // Fix for pixi.js imports
        },
      },
    ],
  },

  plugins: [
    new CleanWebpackPlugin(),

    ...htmlFiles, // Automatically includes all .html files from src/

    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
        { from: 'src/scripts', to: 'scripts', noErrorOnMissing: true },
        { from: 'src/styles', to: 'styles', noErrorOnMissing: true },
        // Regenerate the GitHub Pages custom-domain file on every build (prevents the domain from being dropped when docs/ is cleaned)
        { from: 'src/CNAME', to: 'CNAME', toType: 'file', noErrorOnMissing: true }
      ]
    })
  ]
};
