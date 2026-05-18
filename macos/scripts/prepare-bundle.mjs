import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const macosRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(macosRoot, "..");

const bundleRoot = path.join(macosRoot, "app", "bundle");
const webOutDir = path.join(bundleRoot, "web");
const backendOutDir = path.join(bundleRoot, "backend");
const assetsOutDir = path.join(bundleRoot, "assets");

const backendServerSourceDir = path.join(projectRoot, "server");
const seedSchemaPath = path.join(projectRoot, "seed_schema.sql");
const defaultDbPath = path.join(projectRoot, "jobs.db");
const sourceDbPath = path.resolve(process.env.OPENPOSTINGS_MAC_DB_PATH || defaultDbPath);
const trayIconSourcePath = path.join(projectRoot, "logo.png");
const dockIconPngSourcePath = path.join(projectRoot, "favicon.png");
const dockIconIcoSourcePath = path.join(projectRoot, "favicon.ico");

function runChecked(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function assertExists(targetPath, description) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${description} was not found at ${targetPath}`);
  }
}

function copyRecursive(sourcePath, destinationPath) {
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true
  });
}

function resetBundleDirectory() {
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.mkdirSync(backendOutDir, { recursive: true });
  fs.mkdirSync(assetsOutDir, { recursive: true });
}

function exportWebBundle() {
  runChecked(
    "npx",
    ["expo", "export", "--platform", "web", "--output-dir", webOutDir],
    projectRoot
  );
}

function copyBackendPayload() {
  assertExists(backendServerSourceDir, "server directory");
  assertExists(seedSchemaPath, "seed_schema.sql");
  assertExists(sourceDbPath, "backend database source");

  copyRecursive(backendServerSourceDir, path.join(backendOutDir, "server"));
  fs.copyFileSync(seedSchemaPath, path.join(backendOutDir, "seed_schema.sql"));
  fs.copyFileSync(sourceDbPath, path.join(backendOutDir, "jobs.db"));
}

function generateDockIcon() {
  const dockIconOutputPath = path.join(assetsOutDir, "dockIcon.png");

  if (fs.existsSync(dockIconPngSourcePath)) {
    runChecked(
      "sips",
      ["-z", "1024", "1024", dockIconPngSourcePath, "--out", dockIconOutputPath],
      projectRoot
    );
    return;
  }

  if (fs.existsSync(dockIconIcoSourcePath)) {
    runChecked(
      "sips",
      ["-z", "1024", "1024", dockIconIcoSourcePath, "--out", dockIconOutputPath],
      projectRoot
    );
    return;
  }

  throw new Error("No dock icon source found. Expected favicon.png or favicon.ico in project root.");
}

function copyAssets() {
  assertExists(trayIconSourcePath, "tray icon source");
  fs.copyFileSync(trayIconSourcePath, path.join(assetsOutDir, "trayIcon.png"));
  generateDockIcon();
}

function patchBundledMcpServerForMacRuntime() {
  const bundledMcpServerPath = path.join(backendOutDir, "server", "mcp-apply-server.js");
  assertExists(bundledMcpServerPath, "bundled MCP server");

  let source = fs.readFileSync(bundledMcpServerPath, "utf8");
  const sourceBeforePatch = source;

  source = source.replace(
    "const { open } = require(\"sqlite\");\nconst sqlite3 = require(\"sqlite3\");",
    "const { openDatabase: openDatabaseDriver } = require(\"./db/open-database\");"
  );

  source = source.replace(
    "async function openDatabase() {\n  db = await open({\n    filename: DB_PATH,\n    driver: sqlite3.Database\n  });\n  await ensureTables();\n}",
    "async function openDatabase() {\n  db = await openDatabaseDriver({ filename: DB_PATH });\n  await ensureTables();\n}"
  );

  if (source === sourceBeforePatch) {
    throw new Error("Failed to patch bundled MCP server for mac runtime compatibility.");
  }

  fs.writeFileSync(bundledMcpServerPath, source, "utf8");
}

function main() {
  console.log("[macos] Preparing bundle...");
  resetBundleDirectory();
  exportWebBundle();
  copyBackendPayload();
  patchBundledMcpServerForMacRuntime();
  copyAssets();
  console.log("[macos] Bundle ready.");
}

main();
