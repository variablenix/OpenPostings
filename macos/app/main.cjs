const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell
} = require("electron");

const APP_NAME = "OpenPostings";
const BACKEND_PORT = Number(process.env.OPENPOSTINGS_BACKEND_PORT || 8787);
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 1500;
const BACKEND_READY_TIMEOUT_MS = 20000;
const BACKEND_READY_RETRY_MS = 500;

const bundleRoot = path.join(__dirname, "bundle");
const webRoot = path.join(bundleRoot, "web");
const backendRoot = path.join(bundleRoot, "backend");
const assetsRoot = path.join(bundleRoot, "assets");
const trayIconPath = path.join(assetsRoot, "trayIcon.png");
const dockIconPath = path.join(assetsRoot, "dockIcon.png");
const webIndexPath = path.join(webRoot, "index.html");
const backendEntryPath = path.join(backendRoot, "server", "index.js");
const mcpEntryPath = path.join(backendRoot, "server", "mcp-apply-server.js");
const seededDatabasePath = path.join(backendRoot, "jobs.db");

let mainWindow = null;
let tray = null;
let healthMonitor = null;
let isQuitting = false;
let backendHealthy = false;
let backendProcess = null;
let mcpProcess = null;
let frontendServer = null;
let frontendOrigin = "";

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function resolveWebAssetPath(requestUrlPathname) {
  const rawPath = decodeURIComponent(String(requestUrlPathname || "/"));
  const candidateRelativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const absoluteCandidatePath = path.resolve(webRoot, candidateRelativePath);
  if (!absoluteCandidatePath.startsWith(path.resolve(webRoot))) {
    return null;
  }
  if (fs.existsSync(absoluteCandidatePath) && fs.statSync(absoluteCandidatePath).isFile()) {
    return absoluteCandidatePath;
  }
  return null;
}

async function startFrontendServer() {
  if (frontendServer) return frontendOrigin;
  if (!fs.existsSync(webIndexPath)) return "";

  const server = http.createServer((req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      const parsed = new URL(req.url || "/", `http://${host}`);
      const requestedFilePath = resolveWebAssetPath(parsed.pathname);
      const targetPath = requestedFilePath || webIndexPath;
      const content = fs.readFileSync(targetPath);
      res.statusCode = 200;
      res.setHeader("Content-Type", getContentType(targetPath));
      res.setHeader("Cache-Control", "no-store");
      res.end(content);
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to start frontend server.");
  }

  frontendServer = server;
  frontendOrigin = `http://127.0.0.1:${address.port}`;
  return frontendOrigin;
}

async function stopFrontendServer() {
  if (!frontendServer) return;
  const serverRef = frontendServer;
  frontendServer = null;
  frontendOrigin = "";
  await new Promise((resolve) => {
    serverRef.close(() => resolve());
  });
}

function getRuntimePaths() {
  const runtimeBackendRoot = path.join(app.getPath("userData"), "backend");
  const runtimeLogsRoot = path.join(runtimeBackendRoot, "logs");
  const runtimeDatabasePath = path.join(runtimeBackendRoot, "jobs.db");
  return {
    runtimeBackendRoot,
    runtimeLogsRoot,
    runtimeDatabasePath
  };
}

function ensureRuntimeDatabase() {
  const { runtimeBackendRoot, runtimeDatabasePath } = getRuntimePaths();
  ensureDirectory(runtimeBackendRoot);
  if (!fs.existsSync(runtimeDatabasePath) && fs.existsSync(seededDatabasePath)) {
    fs.copyFileSync(seededDatabasePath, runtimeDatabasePath);
  }
}

function openLogFile(logName) {
  const { runtimeLogsRoot } = getRuntimePaths();
  ensureDirectory(runtimeLogsRoot);
  const fullPath = path.join(runtimeLogsRoot, logName);
  return fullPath;
}

function isProcessAlive(targetProcess) {
  return Boolean(targetProcess && targetProcess.exitCode === null && !targetProcess.killed);
}

function spawnNodeService(entryPath, name, extraEnv = {}) {
  if (!fs.existsSync(entryPath)) {
    return null;
  }

  const stdoutPath = openLogFile(`${name}.out.log`);
  const stderrPath = openLogFile(`${name}.err.log`);
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: "a" });
  const { runtimeDatabasePath } = getRuntimePaths();

  const child = spawn(process.execPath, [entryPath], {
    cwd: path.dirname(entryPath),
    detached: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: "1",
      DB_PATH: runtimeDatabasePath
    }
  });

  if (child.stdout) {
    child.stdout.pipe(stdoutStream);
  }
  if (child.stderr) {
    child.stderr.pipe(stderrStream);
  }

  child.on("exit", () => {
    stdoutStream.end();
    stderrStream.end();
    refreshTrayMenu();
  });
  child.on("error", () => {
    stdoutStream.end();
    stderrStream.end();
    refreshTrayMenu();
  });
  return child;
}

async function stopService(serviceProcess, timeoutMs = 3000) {
  if (!isProcessAlive(serviceProcess)) return;

  serviceProcess.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));

  if (isProcessAlive(serviceProcess)) {
    serviceProcess.kill("SIGKILL");
  }
}

async function stopAllServices() {
  await Promise.all([stopService(backendProcess), stopService(mcpProcess)]);
  backendProcess = null;
  mcpProcess = null;
  backendHealthy = false;
  refreshTrayMenu();
}

function checkBackendHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: BACKEND_PORT,
        path: "/health",
        timeout: HEALTH_CHECK_TIMEOUT_MS
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.on("error", () => {
      resolve(false);
    });
  });
}

async function waitForBackendReady() {
  const start = Date.now();
  while (Date.now() - start < BACKEND_READY_TIMEOUT_MS) {
    if (await checkBackendHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, BACKEND_READY_RETRY_MS));
  }
  return false;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

async function ensureServicesRunning() {
  ensureRuntimeDatabase();

  if (!isProcessAlive(backendProcess)) {
    backendProcess = spawnNodeService(backendEntryPath, "backend", {
      PORT: String(BACKEND_PORT)
    });
  }

  if (!isProcessAlive(mcpProcess)) {
    mcpProcess = spawnNodeService(mcpEntryPath, "ai-engine");
  }

  backendHealthy = await waitForBackendReady();
  refreshTrayMenu();

  if (!backendHealthy) {
    showNotification(APP_NAME, "Backend failed to start. Check logs in Application Support/OpenPostings.");
  }
}

function refreshTrayMenu() {
  if (!tray) return;

  const backendStatus = backendHealthy ? "Running" : "Stopped";
  const aiStatus = isProcessAlive(mcpProcess) ? "Running" : "Stopped";

  const menu = Menu.buildFromTemplate([
    {
      label: `Backend: ${backendStatus}`,
      enabled: false
    },
    {
      label: `AI Engine: ${aiStatus}`,
      enabled: false
    },
    { type: "separator" },
    {
      label: "Open OpenPostings",
      click: () => {
        if (!mainWindow) {
          createMainWindow();
          return;
        }
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: "Restart Backend + AI Engine",
      click: async () => {
        await stopAllServices();
        await ensureServicesRunning();
        showNotification(APP_NAME, "Backend and AI engine restarted.");
      }
    },
    {
      label: "Quit",
      click: async () => {
        isQuitting = true;
        await Promise.all([stopAllServices(), stopFrontendServer()]);
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function startHealthMonitor() {
  if (healthMonitor) {
    clearInterval(healthMonitor);
    healthMonitor = null;
  }

  healthMonitor = setInterval(async () => {
    const wasHealthy = backendHealthy;
    backendHealthy = await checkBackendHealth();
    refreshTrayMenu();
    if (wasHealthy && !backendHealthy) {
      showNotification(APP_NAME, "Backend service is offline.");
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function getTrayImage() {
  const icon = nativeImage.createFromPath(trayIconPath);
  if (icon.isEmpty()) return icon;
  return icon.resize({ width: 18, height: 18 });
}

function createTray() {
  tray = new Tray(getTrayImage());
  tray.setToolTip(APP_NAME);
  tray.on("click", () => {
    if (!mainWindow) {
      createMainWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  refreshTrayMenu();
}

function createMissingBundlePage() {
  const message = encodeURIComponent(
    "OpenPostings mac bundle is missing.\nRun: cd macos && npm run prepare:bundle"
  );
  return `data:text/plain;charset=utf-8,${message}`;
}

function attachExternalNavigationGuards(windowRef) {
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (frontendOrigin && url.startsWith(frontendOrigin)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  windowRef.webContents.on("will-navigate", (event, url) => {
    if (frontendOrigin && url.startsWith(frontendOrigin)) {
      return;
    }
    if (!url.startsWith("file://")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  attachExternalNavigationGuards(mainWindow);

  if (frontendOrigin) {
    mainWindow.loadURL(frontendOrigin);
  } else if (fs.existsSync(webIndexPath)) {
    mainWindow.loadURL(createMissingBundlePage());
  } else {
    mainWindow.loadURL(createMissingBundlePage());
  }

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.setName(APP_NAME);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    await startFrontendServer();
  } catch {
    frontendOrigin = "";
  }
  if (app.dock && fs.existsSync(dockIconPath)) {
    const dockIcon = nativeImage.createFromPath(dockIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }
  createTray();
  createMainWindow();
  await ensureServicesRunning();
  startHealthMonitor();
});

app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    if (healthMonitor) {
      clearInterval(healthMonitor);
      healthMonitor = null;
    }
    await Promise.all([stopAllServices(), stopFrontendServer()]);
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createMainWindow();
});
