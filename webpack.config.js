const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: __dirname + '/dist',
  },
  resolve: {
    alias: {
      'pixi.js': 'pixi.js/dist/pixi.min.js',
    },
  },
  plugins: [
    // Copy assets to the output directory
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/assets', to: 'assets' }, // Adjust paths as needed
      ],
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 8080,
  },
};
