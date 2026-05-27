const { decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const { nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers")

const WEBCRUITER_RATE_LIMIT_WAIT_MS = 60 * 1000;
const WEBCRUITER_ESTIMATED_COMPANY_COUNT = 1400;

function cleanWebcruiterText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanWebcruiterDescription(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .trim();
}

function parseWebcruiterPublishedDateToIso(value) {
  const raw = cleanWebcruiterText(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return raw;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return raw;
  const utcDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (Number.isNaN(utcDate.getTime())) return raw;
  return utcDate.toISOString();
}

function parseWebcruiterPostingsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const rows = Array.isArray(payload.Data) ? payload.Data : [];
  const postings = [];
  const seenUrls = new Set();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const postingId = cleanWebcruiterText(row.Id);
    const openAdvertUrl = cleanWebcruiterText(row.OpenAdvertUrl);
    const jobPostingUrl = openAdvertUrl
      ? openAdvertUrl
      : postingId
        ? `https://candidate.webcruiter.com/en-gb/jobs/${postingId}`
        : "";
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;

    const companyName = cleanWebcruiterText(row.CompanyName) || "Unknown Company";
    const positionName = cleanWebcruiterText(row.Heading) || "Untitled Position";
    const workplace =
      cleanWebcruiterText(row.Workplace) ||
      cleanWebcruiterText(row.Workplace2) ||
      cleanWebcruiterText(row.Workplace3) ||
      null;
    const jobDescription = cleanWebcruiterDescription(row.Presentation) || null;
    const postingDate = parseWebcruiterPublishedDateToIso(row.PublishedDate);

    postings.push({
      company_name: companyName,
      position_name: positionName,
      job_posting_url: jobPostingUrl,
      posting_date: postingDate,
      job_description: jobDescription,
      location: workplace
    });
    seenUrls.add(jobPostingUrl);
  }

  return postings;
}

async function collectPostingsForWebcruiterDynamic() {
  const endpoint = "https://candidate.webcruiter.com/api/odvert/search";
  const baseUrl = "https://candidate.webcruiter.com/en-gb/home/alladverts/webcruiter-id#search";
  const referenceEpoch = nowEpochSeconds();
  const postings = [];
  const seenUrls = new Set();
  const take = 20;
  let skip = 0;
  let page = 1;

  while (true) {
    const body = {
      take,
      skip,
      page,
      pageSize: take,
      sort: [{ field: "1", dir: "desc" }]
    };

    const res = await fetchWithAtsRateLimit("webcruiter", WEBCRUITER_RATE_LIMIT_WAIT_MS, endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        Origin: "https://candidate.webcruiter.com",
        Referer: baseUrl
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Webcruiter request failed (${res.status}): ${errorBody.slice(0, 180)}`);
    }

    const payload = await res.json();
    const batch = parseWebcruiterPostingsFromPayload(payload);
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
    skip += take;
    page += 1;
  }

  return postings;
}

module.exports = { collectPostingsForWebcruiterDynamic, WEBCRUITER_ESTIMATED_COMPANY_COUNT };
