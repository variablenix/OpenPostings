const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const config = getDefaultConfig(__dirname);

const rnwPath = fs.realpathSync(
  path.resolve(require.resolve("react-native-windows/package.json"), "..")
);
const normalizedWindowsPath = path.resolve(__dirname, "windows").replace(/[/\\]/g, "/");
const normalizedRnwPath = rnwPath.replace(/[/\\]/g, "/");
const normalizedNodeAssetsPath = path.resolve(__dirname, "nodejs-assets").replace(/[/\\]/g, "/");

config.resolver.blockList = [
  new RegExp(`${normalizedWindowsPath}.*`),
  new RegExp(`${normalizedNodeAssetsPath}.*`),
  new RegExp(`${normalizedRnwPath}/build/.*`),
  new RegExp(`${normalizedRnwPath}/target/.*`),
  /.*\.ProjectImports\.zip/
];

module.exports = config;
