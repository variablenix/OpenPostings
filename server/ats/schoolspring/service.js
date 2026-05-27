
const { nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SCHOOLSPRING_RATE_LIMIT_WAIT_MS = 60 * 1000;
const SCHOOLSPRING_ESTIMATED_COMPANY_COUNT = 16287;

function parseSchoolspringPostingsFromPayload(payload) {
  const jobs = payload?.value?.jobsList;
  if (!Array.isArray(jobs)) return [];

  const postings = [];
  const seenUrls = new Set();
  for (const job of jobs) {
    const jobId = Number(job?.jobId || 0);
    if (!Number.isFinite(jobId) || jobId <= 0) continue;
    const jobPostingUrl = `https://www.schoolspring.com/job.cfm?jid=${jobId}`;
    if (seenUrls.has(jobPostingUrl)) continue;
    seenUrls.add(jobPostingUrl);

    postings.push({
      company_name: String(job?.employer || "").trim() || "Unknown Employer",
      position_name: String(job?.title || "").trim() || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: String(job?.displayDate || "").trim() || null,
      location: String(job?.location || "").trim() || null
    });
  }
  return postings;
}

async function fetchSchoolspringSearchPayload(page, size = 25) {
  const endpoint = new URL("https://api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch");
  endpoint.searchParams.set("domainName", "");
  endpoint.searchParams.set("keyword", "");
  endpoint.searchParams.set("location", "");
  endpoint.searchParams.set("category", "");
  endpoint.searchParams.set("gradelevel", "");
  endpoint.searchParams.set("jobtype", "");
  endpoint.searchParams.set("organization", "");
  endpoint.searchParams.set("swLat", "");
  endpoint.searchParams.set("swLon", "");
  endpoint.searchParams.set("neLat", "");
  endpoint.searchParams.set("neLon", "");
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("size", String(size));
  endpoint.searchParams.set("sortDateAscending", "false");

  const res = await fetchWithAtsRateLimit("schoolspring", SCHOOLSPRING_RATE_LIMIT_WAIT_MS, endpoint.toString(), {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.schoolspring.com",
      Referer: "https://www.schoolspring.com/"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SchoolSpring request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res.json();
}

async function collectPostingsForSchoolspringDynamic(pageSize = 25) {
  const size = Math.max(1, Number(pageSize) || 25);
  const postings = [];
  const seenUrls = new Set();
  const referenceEpoch = nowEpochSeconds();
  let page = 1;

  while (true) {
    const payload = await fetchSchoolspringSearchPayload(page, size);
    const batch = parseSchoolspringPostingsFromPayload(payload);
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

module.exports = { collectPostingsForSchoolspringDynamic, SCHOOLSPRING_ESTIMATED_COMPANY_COUNT };