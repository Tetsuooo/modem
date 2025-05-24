const path = require('path');
const express = require('express');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  devServer: {
    https: true,
    port: 8085,
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    setupMiddlewares: (middlewares, devServer) => {
      if (!devServer) throw new Error('webpack-dev-server not defined');
      devServer.app.get(
        /^\/assets\/.*\.(jpe?g|png|json)$/,
        express.static(path.join(__dirname, 'src'), { redirect: false })
      );
      return middlewares;
    },
    historyApiFallback: true
  },
  entry: './src/index.js',
  output: {
    filename: 'main.js',
    chunkFilename: '[name].bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  plugins: [
    new webpack.DefinePlugin({
      IMAGE_HOST: JSON.stringify(
        process.env.LOCAL
          ? 'https://localhost:8080'
          : 'https://m-o-d-e-m.s3.eu-central-1.amazonaws.com'
      )
    }),
    new CleanWebpackPlugin(),
    
    new HtmlWebpackPlugin({
      title: 'Modem App',
      filename: 'app.html',
      template: 'src/index.html',
      chunks: ['main']
    }),

    new HtmlWebpackPlugin({
      title: 'Modem Home',
      filename: 'index.html',
      template: 'src/home.html',
      inject: false
    })
  ]
};
