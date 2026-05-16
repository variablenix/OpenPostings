import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

const DB_PATH = process.env.OPENPOSTINGS_LITE_DB_PATH || path.resolve(projectRoot, "jobs_github.db");
const OUTPUT_DIR =
  process.env.OPENPOSTINGS_LITE_OUTPUT_DIR || path.resolve(projectRoot, "docs-site", "static", "lite-data");
const CHUNK_SIZE = parsePositiveInteger(process.env.OPENPOSTINGS_LITE_CHUNK_SIZE, 300);
const WINDOW_HOURS = parsePositiveInteger(process.env.OPENPOSTINGS_LITE_WINDOW_HOURS, 24);
const MAX_ITEMS = parsePositiveInteger(process.env.OPENPOSTINGS_LITE_MAX_ITEMS, 0);
const MAX_OUTPUT_MB = parsePositiveInteger(process.env.OPENPOSTINGS_LITE_MAX_OUTPUT_MB, 0);
const REFERENCE_EPOCH =
  parsePositiveInteger(process.env.OPENPOSTINGS_LITE_REFERENCE_EPOCH, 0) || nowEpochSeconds();
const MAX_OUTPUT_BYTES = MAX_OUTPUT_MB > 0 ? MAX_OUTPUT_MB * 1024 * 1024 : 0;
const INDEX_RESERVED_BYTES = 256 * 1024;

function assertSafeLiteDbPath(dbPath) {
  const resolved = path.resolve(String(dbPath || ""));
  const base = path.basename(resolved).toLowerCase();
  if (base === "jobs.db") {
    throw new Error(
      `Refusing Lite export against '${resolved}'. ` +
        "Use jobs_github.db or a temporary DB copy via OPENPOSTINGS_LITE_DB_PATH."
    );
  }
}

function parsePositiveInteger(value, fallback) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getPostingFreshnessWindowSeconds() {
  return WINDOW_HOURS * 60 * 60;
}

function parsePostingDateToEpochSeconds(postingDate, referenceEpoch = nowEpochSeconds()) {
  const raw = String(postingDate ?? "").trim();
  if (!raw) return null;

  const normalizedLower = raw.toLowerCase();
  if (normalizedLower === "posted today" || normalizedLower === "today") {
    return Number(referenceEpoch);
  }
  if (normalizedLower === "posted yesterday" || normalizedLower === "yesterday") {
    return Number(referenceEpoch) - 24 * 60 * 60;
  }

  const daysAgoMatch = normalizedLower.match(/^(\d+)\s+day(?:s)?\s+ago$/i);
  if (daysAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(daysAgoMatch[1]) * 24 * 60 * 60;
  }

  const hoursAgoMatch = normalizedLower.match(/^(\d+)\s+hour(?:s)?\s+ago$/i);
  if (hoursAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(hoursAgoMatch[1]) * 60 * 60;
  }

  let normalized = raw
    .replace(/^posted\s+/i, "")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (/^\d{10,13}$/.test(normalized)) {
    const numericEpoch = Number(normalized.length === 13 ? Math.floor(Number(normalized) / 1000) : normalized);
    if (Number.isFinite(numericEpoch) && numericEpoch > 0) {
      return numericEpoch;
    }
  }

  const parsedMs = Date.parse(normalized);
  if (Number.isFinite(parsedMs)) return Math.floor(parsedMs / 1000);

  normalized = normalized.replace(/,\s*/g, " ").trim();
  const fallbackParsedMs = Date.parse(normalized);
  if (Number.isFinite(fallbackParsedMs)) return Math.floor(fallbackParsedMs / 1000);

  return null;
}

function shouldStorePostingByDateStrict(postingDate, referenceEpoch = nowEpochSeconds()) {
  const raw = String(postingDate ?? "").trim();
  if (!raw) return false;

  const parsedEpoch = parsePostingDateToEpochSeconds(raw, referenceEpoch);
  if (!parsedEpoch) return false;
  return parsedEpoch >= Number(referenceEpoch) - getPostingFreshnessWindowSeconds();
}

function inferAtsFromJobPostingUrl(value) {
  const url = String(value || "").trim().toLowerCase();
  if (!url) return "";
  if (url.includes("myworkdayjobs.com")) return "workday";
  if (url.includes("jobs.ashbyhq.com")) return "ashby";
  if (url.includes("job-boards.greenhouse.io") || url.includes("boards.greenhouse.io")) return "greenhouse";
  if (url.includes("jobs.lever.co")) return "lever";
  if (url.includes(".recruitee.com")) return "recruitee";
  if (url.includes("recruiting.ultipro.com/") && url.includes("/jobboard/")) return "ultipro";
  if (url.includes(".rec.pro.ukg.net/") && url.includes("/jobboard/")) return "ukg";
  if (url.includes(".taleo.net/careersection/")) return "taleo";
  if ((url.includes("jobs.jobvite.com/") || url.includes("careers.jobvite.com/")) && url.includes("/job/")) {
    return "jobvite";
  }
  if (url.includes(".applicantpro.com/jobs")) return "applicantpro";
  if (url.includes(".applytojob.com/apply")) return "applytojob";
  if (url.includes(".icims.com/jobs/")) return "icims";
  if (url.includes("theapplicantmanager.com/jobs")) return "theapplicantmanager";
  if (url.includes(".breezy.hr/p/")) return "breezy";
  if (url.includes(".zohorecruit.com/jobs/careers")) return "zoho";
  if (url.includes(".bamboohr.com/careers")) return "bamboohr";
  if (url.includes("jobs.smartrecruiters.com/")) return "smartrecruiters";
  if (url.includes("governmentjobs.com/jobs/")) return "governmentjobs";
  if (url.includes("usajobs.gov/job/")) return "usajobs";
  if (url.includes("schoolspring.com/job.cfm?jid=")) return "schoolspring";
  if (url.includes("edjoin.org/home/jobposting/")) return "edjoin";
  if (url.includes("calcareers.ca.gov/calhrpublic/jobs/jobposting.aspx?jobcontrolid=")) return "calcareers";
  if (url.includes("calopps.org/") && url.includes("/job-")) return "calopps";
  if (url.includes("statejobsny.com/public/vacancydetailsview.cfm?id=")) return "statejobsny";
  if (url.includes(".pinpointhq.com/") && url.includes("/postings/")) return "pinpointhq";
  if (url.includes("recruitcrm.io/jobs/")) return "recruitcrm";
  if (url.includes("ats.rippling.com/") && url.includes("/jobs")) return "rippling";
  if (url.includes("careerplug.com/jobs/")) return "careerplug";
  if (url.includes("jobs.gem.com/")) return "gem";
  if (url.includes("talent.sage.hr/jobs/")) return "sagehr";
  if (url.includes(".teamtailor.com/jobs/")) return "teamtailor";
  if (url.includes(".freshteam.com/jobs/")) return "freshteam";
  if (url.includes("jobappnetwork.com/job/")) return "talentreef";
  if (url.includes("web.fountain.com/c/")) return "fountain";
  if (url.includes(".getro.com/jobs")) return "getro";
  if (url.includes(".hrmdirect.com/employment/job-opening.php")) return "hrmdirect";
  if (url.includes("candidate.webcruiter.com/en-gb/jobs/")) return "webcruiter";
  return "";
}

function inferPostingLocationFromJobUrl(jobPostingUrl) {
  const url = String(jobPostingUrl || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname
      .split("/")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    const workdayJobIndex = pathParts.findIndex((part) => part.toLowerCase() === "job");
    if (workdayJobIndex >= 0 && pathParts[workdayJobIndex + 1]) {
      return decodeURIComponent(pathParts[workdayJobIndex + 1]).replace(/-/g, " ").trim();
    }
    return "";
  } catch {
    return "";
  }
}

function formatDurationMs(durationMs) {
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(2)}s`;
}

async function clearOutputDirectory(outputDirectoryPath) {
  await fs.rm(outputDirectoryPath, { recursive: true, force: true });
  await fs.mkdir(outputDirectoryPath, { recursive: true });
}

async function main() {
  const startMs = Date.now();
  const referenceEpoch = Number(REFERENCE_EPOCH);
  const referenceIso = new Date(referenceEpoch * 1000).toISOString();

  console.log("[lite-chunks] Starting build");
  console.log(`[lite-chunks] DB path: ${DB_PATH}`);
  console.log(`[lite-chunks] Output dir: ${OUTPUT_DIR}`);
  console.log(`[lite-chunks] Window hours: ${WINDOW_HOURS}`);
  console.log(`[lite-chunks] Chunk size: ${CHUNK_SIZE}`);
  if (MAX_OUTPUT_BYTES > 0) {
    console.log(`[lite-chunks] Max output: ${MAX_OUTPUT_MB} MB`);
  }
  console.log(`[lite-chunks] Reference time: ${referenceIso}`);

  assertSafeLiteDbPath(DB_PATH);

  await clearOutputDirectory(OUTPUT_DIR);

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });

  const rows = await db.all(
    `
      SELECT
        id,
        company_name,
        position_name,
        job_posting_url,
        posting_date,
        first_seen_epoch,
        last_seen_epoch
      FROM Postings
      WHERE COALESCE(hidden, 0) = 0
        AND posting_date IS NOT NULL
        AND TRIM(posting_date) <> '';
    `
  );

  await db.close();

  console.log(`[lite-chunks] Candidate rows with posting_date: ${rows.length}`);

  const filtered = [];
  let droppedMissingDate = 0;
  let droppedOutsideWindow = 0;
  let droppedUnparseableDate = 0;
  const freshnessCutoff = referenceEpoch - getPostingFreshnessWindowSeconds();

  for (const row of rows) {
    const postingDate = String(row?.posting_date || "").trim();
    if (!postingDate) {
      droppedMissingDate += 1;
      continue;
    }
    const parsedEpoch = parsePostingDateToEpochSeconds(postingDate, referenceEpoch);
    if (!parsedEpoch) {
      droppedUnparseableDate += 1;
      continue;
    }
    if (!shouldStorePostingByDateStrict(postingDate, referenceEpoch)) {
      droppedOutsideWindow += 1;
      continue;
    }

    filtered.push({
      id: Number(row?.id || 0),
      company_name: String(row?.company_name || "").trim(),
      position_name: String(row?.position_name || "").trim() || "Untitled Position",
      job_posting_url: String(row?.job_posting_url || "").trim(),
      posting_date: postingDate,
      posting_epoch: Number(parsedEpoch),
      first_seen_epoch: Number(row?.first_seen_epoch || 0),
      last_seen_epoch: Number(row?.last_seen_epoch || 0),
      ats: inferAtsFromJobPostingUrl(row?.job_posting_url),
      location: inferPostingLocationFromJobUrl(row?.job_posting_url)
    });
  }

  filtered.sort((a, b) => {
    if (b.posting_epoch !== a.posting_epoch) return b.posting_epoch - a.posting_epoch;
    if (b.last_seen_epoch !== a.last_seen_epoch) return b.last_seen_epoch - a.last_seen_epoch;
    return a.id - b.id;
  });

  const itemsToWrite =
    Number.isFinite(MAX_ITEMS) && MAX_ITEMS > 0 ? filtered.slice(0, Math.min(MAX_ITEMS, filtered.length)) : filtered;

  const chunks = [];
  const totalChunksPlanned = Math.ceil(itemsToWrite.length / CHUNK_SIZE);
  let outputBytesWritten = 0;
  let itemsWritten = 0;
  let truncatedDueToMaxOutput = false;
  for (let index = 0; index < totalChunksPlanned; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = start + CHUNK_SIZE;
    const items = itemsToWrite.slice(start, end);
    const fileName = `chunk-${String(index + 1).padStart(3, "0")}.json`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    const payload = {
      chunk_index: index + 1,
      total_chunks: totalChunks,
      count: items.length,
      generated_at: new Date().toISOString(),
      items
    };
    const chunkSerialized = `${JSON.stringify(payload)}\n`;
    const chunkBytes = Buffer.byteLength(chunkSerialized, "utf8");
    if (MAX_OUTPUT_BYTES > 0) {
      const maxChunkBudgetBytes = Math.max(0, MAX_OUTPUT_BYTES - INDEX_RESERVED_BYTES);
      if (outputBytesWritten + chunkBytes > maxChunkBudgetBytes) {
        truncatedDueToMaxOutput = true;
        break;
      }
    }

    await fs.writeFile(filePath, chunkSerialized, "utf8");
    outputBytesWritten += chunkBytes;
    itemsWritten += items.length;
    chunks.push({
      file: fileName,
      count: items.length
    });
  }

  const atsCounts = new Map();
  const writtenItems = itemsToWrite.slice(0, itemsWritten);
  for (const item of writtenItems) {
    const key = String(item?.ats || "").trim() || "unknown";
    atsCounts.set(key, (atsCounts.get(key) || 0) + 1);
  }

  const droppedDueToMaxOutput = Math.max(0, itemsToWrite.length - itemsWritten);
  const indexPayload = {
    generated_at: new Date().toISOString(),
    reference_epoch: referenceEpoch,
    reference_iso: referenceIso,
    window_hours: WINDOW_HOURS,
    freshness_cutoff_epoch: freshnessCutoff,
    chunk_size: CHUNK_SIZE,
    total_items: itemsWritten,
    total_items_planned: itemsToWrite.length,
    total_chunks: chunks.length,
    dropped_missing_date: droppedMissingDate,
    dropped_unparseable_date: droppedUnparseableDate,
    dropped_outside_window: droppedOutsideWindow,
    dropped_due_to_max_output: droppedDueToMaxOutput,
    truncated_due_to_max_output: truncatedDueToMaxOutput,
    max_output_mb: MAX_OUTPUT_MB,
    max_output_bytes: MAX_OUTPUT_BYTES,
    output_bytes_written: outputBytesWritten,
    source_rows_with_dates: rows.length,
    chunks,
    ats_counts: Array.from(atsCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ats, count]) => ({ ats, count }))
  };

  await fs.writeFile(path.join(OUTPUT_DIR, "index.json"), `${JSON.stringify(indexPayload)}\n`, "utf8");

  const durationMs = Date.now() - startMs;
  console.log(`[lite-chunks] Included postings: ${itemsWritten}`);
  console.log(`[lite-chunks] Wrote chunks: ${chunks.length}`);
  console.log(`[lite-chunks] Dropped (outside 24h): ${droppedOutsideWindow}`);
  console.log(`[lite-chunks] Dropped (unparseable date): ${droppedUnparseableDate}`);
  if (truncatedDueToMaxOutput) {
    console.log(`[lite-chunks] Truncated by max output cap: dropped_due_to_max_output=${droppedDueToMaxOutput}`);
  }
  console.log(`[lite-chunks] Build duration: ${formatDurationMs(durationMs)} (${durationMs}ms)`);
}

main().catch((error) => {
  console.error("[lite-chunks] Failed:", error);
  process.exit(1);
});
