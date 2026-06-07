const { parseUrl, decodeHtmlEntities, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const OORWIN_RATE_LIMIT_WAIT_MS = 1000;
const OORWIN_API_URL = "https://api.oorwin.ai/api/v2/careers/getJobList";
const OORWIN_DEFAULT_PAGE_SIZE = 100;

function cleanOorwinText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOorwinCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".oorwin.com")) return null;

  const hostParts = host.split(".").filter(Boolean);
  if (hostParts.length < 3) return null;

  const candidateParts = hostParts.slice(0, -2);
  let subdomain = String(candidateParts[0] || "").trim();
  if (subdomain === "www" && candidateParts.length > 1) {
    subdomain = String(candidateParts[1] || "").trim();
  }
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    boardUrl: `https://${encodeURIComponent(subdomain)}.oorwin.com/careers`
  };
}

function buildOorwinJobPostingUrl(subdomain, postingSha1) {
  const cleanSubdomain = cleanOorwinText(subdomain);
  const cleanPostingSha1 = cleanOorwinText(postingSha1);
  if (!cleanSubdomain || !cleanPostingSha1) return "";
  return `https://${encodeURIComponent(cleanSubdomain)}.oorwin.com/careers/index.html#/job/details/${encodeURIComponent(cleanPostingSha1)}`;
}

function buildOorwinLocationLabel(row) {
  const parts = [
    cleanOorwinText(row?.remote_status),
    cleanOorwinText(row?.country_format_name),
    cleanOorwinText(row?.city)
  ].filter(Boolean);

  return parts.join(", ") || null;
}

function isValidOorwinPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (String(payload?.status || "").trim() === "404") return false;
  if (payload?.success !== 1) return false;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : null;
  const listDetails = data?.list_details && typeof data.list_details === "object" ? data.list_details : null;
  return Array.isArray(listDetails?.data);
}

function getOorwinRows(payload) {
  return Array.isArray(payload?.data?.list_details?.data) ? payload.data.list_details.data : [];
}

function getOorwinTotalCount(payload) {
  const total = Number(payload?.data?.list_details?.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function parseOorwinPostingsFromPayload(companyNameForPostings, subdomain, payload) {
  const rows = getOorwinRows(payload);
  const postings = [];
  const seenUrls = new Set();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const postingSha1 = cleanOorwinText(row?.computed_sha1_job_id);
    const jobPostingUrl = buildOorwinJobPostingUrl(subdomain, postingSha1);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;

    postings.push({
      company_name: companyNameForPostings,
      position_name: cleanOorwinText(row?.title) || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: cleanOorwinText(row?.cp_published_on) || null,
      location: buildOorwinLocationLabel(row)
    });
    seenUrls.add(jobPostingUrl);
  }

  return postings;
}

async function fetchOorwinPayload(subdomain, page = 1, pageSize = OORWIN_DEFAULT_PAGE_SIZE) {
  const requestBody = {
    limit: Math.max(1, Number(pageSize) || OORWIN_DEFAULT_PAGE_SIZE),
    page: Math.max(1, Number(page) || 1),
    order: "cp_published_on",
    sort: "desc",
    list_type: 1,
    Experience: [],
    Job_type: [],
    search2: [],
    sub_domain: subdomain,
    getDefaultData: true,
    template_format: 2
  };

  const res = await fetchWithAtsRateLimit("oorwin", OORWIN_RATE_LIMIT_WAIT_MS, OORWIN_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_BROWSER_USER_AGENT
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Oorwin request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

async function collectPostingsForOorwinCompany(company) {
  const config = parseOorwinCompany(company?.url_string);
  if (!config) return [];

  const companyNameForPostings = String(company?.company_name || "").trim() || config.subdomainLower;
  const postings = [];
  const seenUrls = new Set();
  const referenceEpoch = nowEpochSeconds();
  const pageSize = OORWIN_DEFAULT_PAGE_SIZE;
  let page = 1;
  let totalExpected = null;

  while (true) {
    const payload = await fetchOorwinPayload(config.subdomain, page, pageSize);
    if (!isValidOorwinPayload(payload)) {
      if (page === 1) return [];
      break;
    }

    const rows = getOorwinRows(payload);
    const batch = parseOorwinPostingsFromPayload(companyNameForPostings, config.subdomain, payload);
    totalExpected = getOorwinTotalCount(payload) ?? totalExpected;

    let hasPostingWithinFreshnessWindow = false;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      const postingDate = String(posting?.posting_date || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      if (!postingDate) continue;
      if (!shouldStorePostingByDate(postingDate, referenceEpoch)) continue;
      hasPostingWithinFreshnessWindow = true;
      postings.push(posting);
      seenUrls.add(postingUrl);
    }

    if (!hasPostingWithinFreshnessWindow) break;
    if (!Array.isArray(rows) || rows.length < pageSize) break;
    if (totalExpected !== null && page * pageSize >= totalExpected) break;
    page += 1;
  }

  return postings;
}

module.exports = { collectPostingsForOorwinCompany, parseOorwinCompany };
