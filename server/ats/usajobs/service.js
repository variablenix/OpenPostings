const { decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const USAJOBS_RATE_LIMIT_WAIT_MS = 60 * 1000;
const USAJOBS_ESTIMATED_COMPANY_COUNT = 26;

function cleanUsajobsText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUsajobsOpenDate(dateDisplay) {
  const raw = cleanUsajobsText(dateDisplay);
  if (!raw) return null;
  const match = raw.match(/open\s+(\d{2}\/\d{2}\/\d{4})\s+to/i);
  return match?.[1] || null;
}

function normalizeUsajobsJobPostingUrl(value) {
  const raw = cleanUsajobsText(value);
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").toLowerCase();
    const isUsajobsHost = host === "www.usajobs.gov" || host === "usajobs.gov";
    if (!isUsajobsHost) return parsed.toString();

    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    return parsed.toString();
  } catch {
    return raw;
  }
}

function extractUsajobsRequestVerificationToken(landingHtml) {
  const source = String(landingHtml || "");
  if (!source) return "";

  const tokenPatterns = [
    /<meta[^>]*\bname=["']request-verification-token["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']request-verification-token["']/i
  ];

  for (const pattern of tokenPatterns) {
    const match = source.match(pattern);
    const token = String(match?.[1] || "").trim();
    if (token) return token;
  }

  return "";
}

function parseUsajobsPostingsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const jobs = Array.isArray(payload.Jobs) ? payload.Jobs : [];
  const postings = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;

    let jobPostingUrl = normalizeUsajobsJobPostingUrl(job.PositionURI);
    if (!jobPostingUrl) {
      const documentId = cleanUsajobsText(job.DocumentID);
      if (documentId) {
        jobPostingUrl = `https://www.usajobs.gov/job/${documentId}`;
      }
    }
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;

    const positionName = cleanUsajobsText(job.Title) || "Untitled Position";
    const companyName = cleanUsajobsText(job.Agency) || "Unknown Agency";
    const location =
      cleanUsajobsText(job.LocationName || job.Location || job.PositionLocationDisplay || job.PositionLocation) || null;
    const postingDate = extractUsajobsOpenDate(job.DateDisplay);

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

async function collectPostingsForUsajobsDynamic(maxPages = 2, resultsPerPage = 25) {
  const executeUrl = "https://www.usajobs.gov/Search/ExecuteSearch";
  const resultsUrl = "https://www.usajobs.gov/Search/Results?hp=public&s=startdate&sd=desc&p=1";

  const landingRes = await fetchWithAtsRateLimit("usajobs", USAJOBS_RATE_LIMIT_WAIT_MS, resultsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!landingRes.ok) {
    const body = await landingRes.text();
    throw new Error(`USAJobs landing request failed (${landingRes.status}): ${body.slice(0, 180)}`);
  }
  const landingHtml = await landingRes.text();
  const requestVerificationToken = extractUsajobsRequestVerificationToken(landingHtml);

  const collected = [];
  const seenUrls = new Set();
  let totalPages = 1;
  const pageLimit = Math.max(1, Math.min(20, Number(maxPages) || 2));
  const perPage = Math.max(1, Math.min(100, Number(resultsPerPage) || 25));

  for (let page = 1; page <= pageLimit; page += 1) {
    const requestBody = {
      JobTitle: [],
      GradeBucket: [],
      JobCategoryCode: [],
      JobCategoryFamily: [],
      LocationName: [],
      Department: [],
      Agency: [],
      PositionOfferingTypeCode: [],
      TravelPercentage: [],
      PositionScheduleTypeCode: [],
      SecurityClearanceRequired: [],
      PositionSensitivity: [],
      JobGradeCode: [],
      SortField: "startdate",
      SortDirection: "desc",
      Page: String(page),
      ShowAllFilters: [],
      HiringPath: ["public"],
      SocTitle: [],
      ResultsPerPage: perPage,
      MCOTags: [],
      CyberWorkRole: [],
      CyberWorkGrouping: [],
      JobType: []
    };

    const requestHeaders = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.usajobs.gov",
      Referer: resultsUrl
    };
    if (requestVerificationToken) {
      requestHeaders.RequestVerificationToken = requestVerificationToken;
    }

    const res = await fetchWithAtsRateLimit("usajobs", USAJOBS_RATE_LIMIT_WAIT_MS, executeUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`USAJobs search request failed (${res.status}): ${body.slice(0, 180)}`);
    }

    const payload = await res.json();
    const numberOfPagesRaw = Number(payload?.Pager?.NumberOfPages);
    if (Number.isFinite(numberOfPagesRaw) && numberOfPagesRaw > 0) {
      totalPages = numberOfPagesRaw;
    }

    const batch = parseUsajobsPostingsFromPayload(payload);
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      collected.push(posting);
      seenUrls.add(postingUrl);
    }

    if (page >= totalPages) break;
  }

  return collected;
}

module.exports = { collectPostingsForUsajobsDynamic, USAJOBS_ESTIMATED_COMPANY_COUNT };
