const { shouldStorePostingByDate, nowEpochSeconds } = require("../../helpers/normalize-numbers");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const { decodeHtmlEntities } = require("../../helpers/normalize-strings");

const K12JOBSPOT_RATE_LIMIT_WAIT_MS = 60 * 1000;
const K12JOBSPOT_ESTIMATED_COMPANY_COUNT = 13000;

function cleanK12jobspotText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseK12jobspotPostingsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const postings = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const jobId = cleanK12jobspotText(job.id);
    if (!jobId) continue;

    const jobPostingUrl = `https://www.k12jobspot.com/Job/Detail/${jobId}`;
    if (seenUrls.has(jobPostingUrl)) continue;

    const companyName = cleanK12jobspotText(job.hiringOrganization) || "Unknown Organization";
    const positionName = cleanK12jobspotText(job.title) || "Untitled Position";
    const locationObj = job.location && typeof job.location === "object" ? job.location : {};
    const city = cleanK12jobspotText(locationObj.city);
    const region = cleanK12jobspotText(locationObj.regionCode);
    const postal = cleanK12jobspotText(locationObj.postalCode);
    const locationParts = [city, region, postal].filter(Boolean);
    const location = locationParts.length > 0 ? locationParts.join(", ") : null;
    const postingDate = cleanK12jobspotText(job.postedDate) || null;

    postings.push({
      company_name: companyName,
      position_name: positionName,
      job_posting_url: jobPostingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(jobPostingUrl);
  }

  return postings;
}

async function fetchK12jobspotSearchPayload(pageStartIndex, pageEndIndex) {
  const endpoint = "https://api.k12jobspot.com/api/Jobs/Search";
  const requestBody = {
    searchPhrase: "",
    filters: [
      { name: "positionAreas", filters: [] },
      { name: "gradeLevels", filters: [] },
      { name: "jobTypes", filters: [] }
    ],
    pageStartIndex,
    pageEndIndex
  };

  const res = await fetchWithAtsRateLimit("k12jobspot", K12JOBSPOT_RATE_LIMIT_WAIT_MS, endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: "https://www.k12jobspot.com",
      Referer: "https://www.k12jobspot.com/"
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`K12JobSpot request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res.json();
}

async function collectPostingsForK12jobspotDynamic(pageWindowSize = 25) {
  const windowSize = Math.max(1, Number(pageWindowSize) || 25);
  const postings = [];
  const seenUrls = new Set();
  const referenceEpoch = nowEpochSeconds();
  let pageStartIndex = 1;

  while (true) {
    const pageEndIndex = pageStartIndex + windowSize - 1;
    const payload = await fetchK12jobspotSearchPayload(pageStartIndex, pageEndIndex);
    const batch = parseK12jobspotPostingsFromPayload(payload);
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
    pageStartIndex = pageEndIndex + 1;
  }

  return postings;
}

module.exports = { collectPostingsForK12jobspotDynamic, K12JOBSPOT_ESTIMATED_COMPANY_COUNT };