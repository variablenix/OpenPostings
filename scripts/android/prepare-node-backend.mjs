import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const nodeAssetsRoot = path.join(projectRoot, "nodejs-assets");
const nodeProjectRoot = path.join(nodeAssetsRoot, "nodejs-project");
const backendRoot = path.join(nodeProjectRoot, "openpostings-backend");
const sourceServerDir = path.join(projectRoot, "server");
const sourceSeedSchemaPath = path.join(projectRoot, "seed_schema.sql");
const sourceDbPath = path.join(projectRoot, "jobs_github.db");

const nodeProjectPackageJsonPath = path.join(nodeProjectRoot, "package.json");
const nodeProjectMainPath = path.join(nodeProjectRoot, "main.js");
const buildNativeModulesFlagPath = path.join(nodeAssetsRoot, "BUILD_NATIVE_MODULES.txt");

function ensureDirectory(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function writeUtf8File(filePath, content) {
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, content, "utf8");
}

function writeNodeProjectPackageJson() {
  const packageJson = {
    name: "openpostings-android-node-runtime",
    private: true,
    version: "1.0.0",
    main: "main.js",
    description: "Node.js runtime bundle for OpenPostings Android backend service",
    dependencies: {
      cors: "^2.8.6",
      express: "^4.21.2",
      "sql.js": "^1.13.0"
    }
  };
  writeUtf8File(nodeProjectPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function writeNodeProjectMainFile() {
  const mainJs = `const fs = require("fs");
const path = require("path");
const rnBridge = require("rn-bridge");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function boot() {
  const dataDirectory = rnBridge.app.datadir();
  const runtimeRoot = path.join(dataDirectory, "openpostings-runtime");
  const runtimeDataRoot = path.join(runtimeRoot, "data");
  const bundledBackendRoot = path.join(__dirname, "openpostings-backend");

  ensureDir(runtimeRoot);
  ensureDir(runtimeDataRoot);

  const runtimeDbPath = path.join(runtimeDataRoot, "jobs.db");
  if (!fs.existsSync(runtimeDbPath)) {
    fs.copyFileSync(path.join(bundledBackendRoot, "jobs.db"), runtimeDbPath);
  }

  process.env.PORT = process.env.PORT || "8787";
  process.env.DB_PATH = runtimeDbPath;
  process.env.OPENPOSTINGS_DB_DRIVER = "sqljs";
  process.env.OPENPOSTINGS_USE_SQLJS = "1";

  rnBridge.channel.send({
    type: "backend_runtime_booting",
    db_path: runtimeDbPath,
    backend_root: bundledBackendRoot,
    runtime_root: runtimeRoot
  });

  // Execute backend from bundled assets so Node dependency resolution can use bundled node_modules.
  require(path.join(bundledBackendRoot, "server", "index.js"));
}

try {
  boot();
} catch (error) {
  rnBridge.channel.send({
    type: "backend_runtime_failed",
    message: String(error?.stack || error?.message || error)
  });
  throw error;
}
`;
  writeUtf8File(nodeProjectMainPath, mainJs);
}

function copyBackendFiles() {
  if (!existsSync(sourceServerDir)) {
    throw new Error(`Server directory not found at ${sourceServerDir}`);
  }
  if (!existsSync(sourceSeedSchemaPath)) {
    throw new Error(`seed_schema.sql not found at ${sourceSeedSchemaPath}`);
  }
  if (!existsSync(sourceDbPath)) {
    throw new Error(`jobs_github.db not found at ${sourceDbPath}`);
  }

  ensureDirectory(backendRoot);
  cpSync(sourceServerDir, path.join(backendRoot, "server"), {
    recursive: true,
    force: true
  });
  writeFileSync(path.join(backendRoot, "seed_schema.sql"), readFileSync(sourceSeedSchemaPath));
  writeFileSync(path.join(backendRoot, "jobs.db"), readFileSync(sourceDbPath));
}

function writeBuildNativeModulesFlag() {
  // We explicitly avoid native Node addons in the Android runtime bundle.
  writeUtf8File(buildNativeModulesFlagPath, "0\n");
}

function installNodeProjectDependencies() {
  execSync("npm install --omit=dev", {
    cwd: nodeProjectRoot,
    stdio: "inherit"
  });
}

writeNodeProjectPackageJson();
writeNodeProjectMainFile();
copyBackendFiles();
writeBuildNativeModulesFlag();
installNodeProjectDependencies();

console.log("[prepare-node-backend] Node backend runtime bundle is ready.");
