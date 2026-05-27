const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { shouldStorePostingByDate, nowEpochSeconds } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const MAX_PAGES_PER_COMPANY = 25;
const PAYCOMONLINE_RATE_LIMIT_WAIT_MS = 60 * 1000;
async function collectPostingsForPaycomonlineCompany(company) {
  const config = parsePaycomonlineCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const boardRes = await fetchWithAtsRateLimit("paycomonline", PAYCOMONLINE_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!boardRes.ok) {
    const body = await boardRes.text();
    throw new Error(`PaycomOnline board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
  }
  const boardHtml = await boardRes.text();
  const sessionJwt = extractPaycomonlineSessionJwt(boardHtml);
  if (!sessionJwt) {
    throw new Error("PaycomOnline sessionJWT not found in board HTML");
  }

  const apiHeaders = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Authorization: sessionJwt,
    Locale: "en-US",
    "Translation-Highlights": "false",
    Origin: "https://www.paycomonline.net",
    Referer: config.boardUrl
  };

  let companyNameFromApi = "";
  const companyNameRes = await fetchWithAtsRateLimit(
    "paycomonline",
    PAYCOMONLINE_RATE_LIMIT_WAIT_MS,
    config.companyNameUrl,
    { method: "GET", headers: apiHeaders }
  );
  if (companyNameRes.ok) {
    try {
      const companyNameJson = await companyNameRes.json();
      companyNameFromApi = decodeHtmlEntities(String(companyNameJson?.companyName || "").trim());
    } catch {
      companyNameFromApi = "";
    }
  }
  const companyNameForPostings =
    normalizedCompanyName || companyNameFromApi || `paycomonline_${String(config.clientKeyLower || "").slice(0, 8)}`;

  const pageSize = 50;
  const collected = [];
  const seenUrls = new Set();

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const skip = page * pageSize;
    const payload = {
      skip,
      take: pageSize,
      filtersForQuery: {
        distanceFrom: 0,
        workEnvironments: [],
        positionTypes: [],
        educationLevels: [],
        categories: [],
        travelTypes: [],
        shiftTypes: [],
        otherFilters: [],
        keywordSearchText: "",
        location: "",
        sortOption: ""
      }
    };

    const res = await fetchWithAtsRateLimit(
      "paycomonline",
      PAYCOMONLINE_RATE_LIMIT_WAIT_MS,
      config.postingsSearchUrl,
      { method: "POST", headers: apiHeaders, body: JSON.stringify(payload) }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PaycomOnline postings request failed (${res.status}): ${body.slice(0, 180)}`);
    }

    const responseJson = await res.json();
    const batch = parsePaycomonlinePostingsFromPayload(responseJson, companyNameForPostings);
    if (batch.length === 0) break;

    let hasWithin24h = false;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      if (!shouldStorePostingByDate(posting?.posting_date, nowEpochSeconds())) continue;
      hasWithin24h = true;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    if (!hasWithin24h) break;
    const totalCount = Number(responseJson?.jobPostingPreviewsCount);
    if (batch.length < pageSize) break;
    if (Number.isFinite(totalCount) && totalCount >= 0 && skip + pageSize >= totalCount) break;
  }

  return collected;
}


function parsePaycomonlineCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "www.paycomonline.net" && host !== "paycomonline.net") return null;

  const path = String(parsed.pathname || "");
  const clientKeyMatch = path.match(/\/portal\/([A-F0-9]{32})\/career-page/i);
  const clientKey = String(clientKeyMatch?.[1] || "").trim();
  if (!clientKey) return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  const boardUrl = `${baseOrigin}/v4/ats/web.php/portal/${clientKey}/career-page`;
  return {
    host,
    clientKey,
    clientKeyLower: clientKey.toLowerCase(),
    boardUrl,
    companyNameUrl: "https://portal-applicant-tracking.us-cent.paycomonline.net/api/ats/company-name",
    postingsSearchUrl:
      "https://portal-applicant-tracking.us-cent.paycomonline.net/api/ats/job-posting-previews/search"
  };
}


function extractPaycomonlineSessionJwt(pageHtml) {
  const source = String(pageHtml || "");
  const match = source.match(/"sessionJWT":"([^"]+)"/i);
  return match?.[1] ? decodeHtmlEntities(String(match[1]).trim()) : "";
}

function parsePaycomonlinePublishedDateToIso(value) {
  const raw = decodeHtmlEntities(String(value || "").trim());
  if (!raw) return null;
  const mmddMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!mmddMatch) return raw;
  const month = Number(mmddMatch[1]);
  const day = Number(mmddMatch[2]);
  const year = Number(mmddMatch[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return raw;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString();
}

function parsePaycomonlinePostingsFromPayload(payload, companyName) {
  const rows = Array.isArray(payload?.jobPostingPreviews) ? payload.jobPostingPreviews : [];
  const postings = [];
  const seenUrls = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const jobId = String(row.jobId || "").trim();
    if (!jobId) continue;
    const openAdvertUrl = decodeHtmlEntities(String(row.openAdvertUrl || "").trim());
    const jobPostingUrl = openAdvertUrl || `https://www.paycomonline.net/v4/ats/web.php/jobs/ViewJobDetails?job=${encodeURIComponent(jobId)}`;
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;

    postings.push({
      company_name: String(companyName || "").trim() || "Unknown Company",
      position_name: decodeHtmlEntities(String(row.jobTitle || "").trim()) || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: parsePaycomonlinePublishedDateToIso(row.postedOn),
      location: decodeHtmlEntities(String(row.locations || "").trim()) || null
    });
    seenUrls.add(jobPostingUrl);
  }
  return postings;
}


module.exports = { collectPostingsForPaycomonlineCompany, parsePaycomonlineCompany };