const path = require('path');
const fs = require('fs');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Dynamically generate HtmlWebpackPlugin instances for each .html file in src/
const htmlFiles = fs
  .readdirSync(path.resolve(__dirname, 'src'))
  .filter(file => path.extname(file).toLowerCase() === '.html')
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
        { from: 'src/styles', to: 'styles', noErrorOnMissing: true }
      ]
    })
  ]
};
