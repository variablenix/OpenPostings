import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

const SOURCE_DB_PATH = process.env.OPENPOSTINGS_LITE_SOURCE_DB_PATH || path.resolve(projectRoot, "jobs_github.db");
const SERVER_PORT = Number(process.env.OPENPOSTINGS_LITE_BENCH_PORT || 0);
const SERVER_START_TIMEOUT_MS = Number(process.env.OPENPOSTINGS_LITE_START_TIMEOUT_MS || 180000);
const SERVER_SYNC_TIMEOUT_MS = Number(process.env.OPENPOSTINGS_LITE_SYNC_TIMEOUT_MS || 5400000);
const CHUNK_SIZE = Number(process.env.OPENPOSTINGS_LITE_CHUNK_SIZE || 300);
const WINDOW_HOURS = Number(process.env.OPENPOSTINGS_LITE_WINDOW_HOURS || 24);
const SYNC_WORKER_CONCURRENCY = Number(process.env.OPENPOSTINGS_LITE_BENCH_SYNC_WORKERS || 30);
const ATS_RATE_LIMIT_MAX_RETRIES = Number(process.env.OPENPOSTINGS_LITE_BENCH_ATS_RATE_LIMIT_MAX_RETRIES || 8);
const ATS_RATE_LIMIT_MAX_COOLDOWN_MS = Number(
  process.env.OPENPOSTINGS_LITE_BENCH_ATS_RATE_LIMIT_MAX_COOLDOWN_MS || 300000
);

function nowMs() {
  return Date.now();
}

function formatDuration(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(2)}s`;
  const minutes = Math.floor(totalSec / 60);
  const remSec = totalSec - minutes * 60;
  return `${minutes}m ${remSec.toFixed(2)}s`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function normalizeWindowsPathForCompare(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

async function findAvailablePort(startPort = 8799, maxAttempts = 200) {
  let candidate = Math.max(1024, Number(startPort) || 8799);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = candidate + attempt;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`Unable to find available port in range ${candidate}-${candidate + maxAttempts - 1}`);
}

async function waitForHealth(baseUrl, timeoutMs, expectedDbPath) {
  const expectedDb = normalizeWindowsPathForCompare(expectedDbPath);
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const payload = await response.json();
        const actualDb = normalizeWindowsPathForCompare(payload?.db_path || "");
        if (actualDb !== expectedDb) {
          throw new Error(
            `Benchmark server db_path mismatch on ${baseUrl}. Expected '${expectedDbPath}', got '${payload?.db_path || ""}'`
          );
        }
        return;
      }
    } catch {
      // server booting
    }
    await sleep(2000);
  }
  throw new Error(`Server health check timed out after ${timeoutMs}ms`);
}

async function waitForSyncCompletion(baseUrl, timeoutMs) {
  const startedAtMs = nowMs();
  const deadline = nowMs() + timeoutMs;
  let nextLogMs = nowMs();
  let lastProgressSnapshot = "";
  let lastProgressAdvanceMs = nowMs();
  while (nowMs() < deadline) {
    const response = await fetch(`${baseUrl}/sync/status`);
    if (!response.ok) {
      await sleep(3000);
      continue;
    }
    const payload = await response.json();
    const running = Boolean(payload?.running);
    if (running && nowMs() >= nextLogMs) {
      const progress = payload?.progress || {};
      const current = Number(progress?.current || 0);
      const total = Number(progress?.total || 0);
      const companyName = String(progress?.company_name || "").trim();
      const collected = Number(progress?.total_collected || 0);
      const snapshot = `${current}:${total}:${companyName}:${collected}`;
      if (snapshot !== lastProgressSnapshot) {
        lastProgressSnapshot = snapshot;
        lastProgressAdvanceMs = nowMs();
      }
      const stalledMs = nowMs() - lastProgressAdvanceMs;
      const elapsedMs = nowMs() - startedAtMs;
      const percent = total > 0 ? ((current / total) * 100).toFixed(2) : "0.00";
      let etaSegment = "";
      if (current > 0 && total > current) {
        const estimatedRemainingMs = (elapsedMs / current) * (total - current);
        if (Number.isFinite(estimatedRemainingMs) && estimatedRemainingMs > 0) {
          etaSegment = ` eta=${formatDuration(estimatedRemainingMs)}`;
        }
      }
      console.log(
        `[lite-bench] Sync progress: ${current}/${total} (${percent}%) elapsed=${formatDuration(elapsedMs)}${etaSegment} collected=${collected}${companyName ? ` current=${companyName}` : ""}${stalledMs >= 60000 ? ` stalled=${formatDuration(stalledMs)}` : ""}`
      );
      nextLogMs = nowMs() + 30000;
    }
    if (!running && payload?.last_sync_summary) {
      return payload;
    }
    await sleep(5000);
  }
  throw new Error(`Sync completion timed out after ${timeoutMs}ms`);
}

function assertSafeSourcePath(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const base = path.basename(resolved).toLowerCase();
  if (base === "jobs.db") {
    throw new Error(
      `Refusing benchmark source '${resolved}'. ` +
        "Use jobs_github.db or OPENPOSTINGS_LITE_SOURCE_DB_PATH that is not jobs.db."
    );
  }
}

async function run() {
  const sourcePath = path.resolve(SOURCE_DB_PATH);
  assertSafeSourcePath(sourcePath);

  await fs.access(sourcePath);
  const sourceHashBefore = await sha256File(sourcePath);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openpostings-lite-bench-"));
  const tempDbPath = path.join(workDir, "openpostings-lite.db");
  const chunkOutputDir = path.join(workDir, "lite-chunks");
  const serverLogPath = path.join(workDir, "lite-server.log");

  console.log(`[lite-bench] Source DB: ${sourcePath}`);
  console.log(`[lite-bench] Source hash(before): ${sourceHashBefore}`);
  console.log(`[lite-bench] Temp workspace: ${workDir}`);
  console.log(`[lite-bench] Sync workers: ${Math.max(1, Math.floor(SYNC_WORKER_CONCURRENCY || 1))}`);
  console.log(
    `[lite-bench] ATS retry caps: retries=${Math.max(0, Math.floor(ATS_RATE_LIMIT_MAX_RETRIES))} cooldown_ms=${Math.max(0, Math.floor(ATS_RATE_LIMIT_MAX_COOLDOWN_MS))}`
  );

  const copyStartMs = nowMs();
  await fs.copyFile(sourcePath, tempDbPath);
  const copyDurationMs = nowMs() - copyStartMs;
  console.log(`[lite-bench] Copied DB in ${formatDuration(copyDurationMs)}`);

  const serverPort = Number.isFinite(SERVER_PORT) && SERVER_PORT > 0 ? Math.floor(SERVER_PORT) : await findAvailablePort();
  const serverLog = await fs.open(serverLogPath, "a");
  const serverEnv = {
    ...process.env,
    PORT: String(serverPort),
    DB_PATH: tempDbPath,
    SYNC_WORKER_CONCURRENCY: String(Math.max(1, Math.floor(SYNC_WORKER_CONCURRENCY || 1))),
    ATS_REQUEST_QUEUE_CONCURRENCY: "1",
    ATS_RATE_LIMIT_MAX_RETRIES: String(Math.max(0, Math.floor(ATS_RATE_LIMIT_MAX_RETRIES))),
    ATS_RATE_LIMIT_MAX_COOLDOWN_MS: String(Math.max(0, Math.floor(ATS_RATE_LIMIT_MAX_COOLDOWN_MS))),
    SYNC_INTERVAL_MS: "86400000"
  };

  const serverProcess = spawn("node", ["server/index.js"], {
    cwd: projectRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout.pipe(serverLog.createWriteStream());
  serverProcess.stderr.pipe(serverLog.createWriteStream());

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  console.log(`[lite-bench] Server port: ${serverPort}`);
  const pipelineStartMs = nowMs();
  let syncDurationMs = 0;
  let chunkDurationMs = 0;
  let syncPayload = null;
  let chunkIndexSummary = null;

  try {
    await waitForHealth(baseUrl, SERVER_START_TIMEOUT_MS, tempDbPath);
    console.log("[lite-bench] Server healthy");

    const syncStartMs = nowMs();
    const triggerResponse = await fetch(`${baseUrl}/sync/ats`, {
      method: "POST"
    });
    if (!triggerResponse.ok) {
      throw new Error(`Sync trigger failed (${triggerResponse.status})`);
    }
    syncPayload = await waitForSyncCompletion(baseUrl, SERVER_SYNC_TIMEOUT_MS);
    syncDurationMs = nowMs() - syncStartMs;
    console.log(`[lite-bench] Sync completed in ${formatDuration(syncDurationMs)}`);

    const chunkStartMs = nowMs();
    const chunkBuilder = spawn(
      "node",
      ["scripts/lite/build-lite-chunks.mjs"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENPOSTINGS_LITE_DB_PATH: tempDbPath,
          OPENPOSTINGS_LITE_OUTPUT_DIR: chunkOutputDir,
          OPENPOSTINGS_LITE_CHUNK_SIZE: String(CHUNK_SIZE),
          OPENPOSTINGS_LITE_WINDOW_HOURS: String(WINDOW_HOURS)
        },
        stdio: "inherit"
      }
    );
    await new Promise((resolve, reject) => {
      chunkBuilder.on("error", reject);
      chunkBuilder.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Chunk builder exited with code ${code}`));
      });
    });
    chunkDurationMs = nowMs() - chunkStartMs;
    console.log(`[lite-bench] Chunk export completed in ${formatDuration(chunkDurationMs)}`);

    const indexPath = path.join(chunkOutputDir, "index.json");
    const indexRaw = await fs.readFile(indexPath, "utf8");
    chunkIndexSummary = JSON.parse(indexRaw);
  } finally {
    if (!serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => serverProcess.once("exit", resolve)),
        sleep(5000).then(() => {
          if (!serverProcess.killed) serverProcess.kill("SIGKILL");
        })
      ]);
    }
    await serverLog.close();
  }

  const sourceHashAfter = await sha256File(sourcePath);
  const sourceUnchanged = sourceHashAfter === sourceHashBefore;
  const totalDurationMs = nowMs() - pipelineStartMs;

  console.log("");
  console.log("=== Lite Benchmark Summary ===");
  console.log(`sync_duration: ${formatDuration(syncDurationMs)} (${syncDurationMs}ms)`);
  console.log(`chunk_duration: ${formatDuration(chunkDurationMs)} (${chunkDurationMs}ms)`);
  console.log(`total_duration: ${formatDuration(totalDurationMs)} (${totalDurationMs}ms)`);
  console.log(`source_db_unchanged: ${sourceUnchanged}`);
  console.log(`source_hash_after: ${sourceHashAfter}`);
  console.log(`temp_db: ${tempDbPath}`);
  console.log(`chunk_output: ${chunkOutputDir}`);
  console.log(`server_log: ${serverLogPath}`);

  if (syncPayload?.last_sync_summary) {
    const summary = syncPayload.last_sync_summary;
    console.log(
      `sync_totals: companies=${summary.total_companies} stored=${summary.total_postings_stored} failed=${summary.failed_companies}`
    );
    console.log(
      `sync_filters: posting_date_pruned=${summary.posting_date_pruned} excluded_during_sync_by_posting_date=${summary.excluded_during_sync_by_posting_date}`
    );
  }

  if (chunkIndexSummary) {
    console.log(
      `chunk_totals: items=${chunkIndexSummary.total_items} chunks=${chunkIndexSummary.total_chunks} dropped_outside_window=${chunkIndexSummary.dropped_outside_window}`
    );
  }
}

run().catch((error) => {
  console.error("[lite-bench] Failed:", error);
  process.exit(1);
});
