const { toCleanString } = require("../../helpers/normalize-strings");
const { nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const EDJOIN_RATE_LIMIT_WAIT_MS = 60 * 1000;
const EDJOIN_ESTIMATED_COMPANY_COUNT = 3182;

function parseEdjoinPostingDate(value) {
  const source = toCleanString(value);
  const match = /\/Date\((?<ms>-?\d+)\)\//i.exec(source);
  const millis = Number.parseInt(String(match?.groups?.ms || ""), 10);
  if (!Number.isFinite(millis)) return null;
  const iso = new Date(millis).toISOString();
  return iso || null;
}

function parseEdjoinPostingsFromPayload(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const postings = [];
  const seenUrls = new Set();

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const postingId = toCleanString(item?.postingID);
    if (!postingId) continue;
    const jobPostingUrl = `https://www.edjoin.org/Home/JobPosting/${postingId}`;
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;
    const city = toCleanString(item?.city);
    const county = toCleanString(item?.countyName);
    const location = [city, county].filter(Boolean).join(", ") || null;

    postings.push({
      company_name: toCleanString(item?.districtName) || "Unknown District",
      position_name: toCleanString(item?.positionTitle) || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: parseEdjoinPostingDate(item?.postingDate),
      location
    });
    seenUrls.add(jobPostingUrl);
  }

  return postings;
}

async function collectPostingsForEdjoinDynamic(rows = 25) {
  const endpoint = "https://www.edjoin.org/Home/LoadJobs";
  const pageSize = Math.max(1, Number.parseInt(String(rows || 25), 10) || 25);
  const referenceEpoch = nowEpochSeconds();
  const postings = [];
  const seenUrls = new Set();
  let page = 1;

  while (true) {
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set("rows", String(pageSize));
    requestUrl.searchParams.set("page", String(page));
    requestUrl.searchParams.set("sort", "postingDate");
    requestUrl.searchParams.set("sortVal", "2");
    requestUrl.searchParams.set("order", "desc");
    requestUrl.searchParams.set("keywords", "");
    requestUrl.searchParams.set("location", "");
    requestUrl.searchParams.set("searchType", "all");
    requestUrl.searchParams.set("regions", "");
    requestUrl.searchParams.set("jobTypes", "");
    requestUrl.searchParams.set("days", "0");
    requestUrl.searchParams.set("empType", "");
    requestUrl.searchParams.set("catID", "0");
    requestUrl.searchParams.set("onlineApps", "false");
    requestUrl.searchParams.set("recruitmentCenterID", "0");
    requestUrl.searchParams.set("stateID", "0");
    requestUrl.searchParams.set("regionID", "0");
    requestUrl.searchParams.set("districtID", "0");
    requestUrl.searchParams.set("searchID", "0");
    requestUrl.searchParams.set("_", String(Date.now()));

    const res = await fetchWithAtsRateLimit("edjoin", EDJOIN_RATE_LIMIT_WAIT_MS, requestUrl.toString(), {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://www.edjoin.org",
        Referer: "https://www.edjoin.org/"
      }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`EdJoin request failed (${res.status}): ${body.slice(0, 180)}`);
    }

    const payload = await res.json();
    const batch = parseEdjoinPostingsFromPayload(payload);
    if (batch.length === 0) break;

    let hasWithin24h = false;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      if (!shouldStorePostingByDate(posting?.posting_date, referenceEpoch)) continue;
      hasWithin24h = true;
      postings.push(posting);
      seenUrls.add(postingUrl);
    }

    if (!hasWithin24h) break;
    page += 1;
  }

  return postings;
}

module.exports = { collectPostingsForEdjoinDynamic, EDJOIN_ESTIMATED_COMPANY_COUNT };