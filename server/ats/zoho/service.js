const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const ZOHO_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForZohoCompany(company) {
  const config = parseZohoCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const pageHtml = await fetchZohoCareersPage(config.careersUrl);
  return parseZohoPostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function parseZohoCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".zohorecruit.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const careersUrl = new URL(parsed.toString());
  careersUrl.pathname = "/jobs/Careers";
  careersUrl.search = "";
  careersUrl.hash = "";

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    origin: `${parsed.protocol}//${parsed.host}`,
    careersUrl: careersUrl.toString()
  };
}



function extractZohoHiddenInputValue(pageHtml, inputId) {
  const source = String(pageHtml || "");
  const tagMatch = source.match(
    new RegExp(`<input[^>]*\\bid=["']${String(inputId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "is")
  );
  if (!tagMatch?.[0]) return "";

  const valueMatch = tagMatch[0].match(/\bvalue=["']([\s\S]*?)["']/i);
  return String(valueMatch?.[1] || "").trim();
}

function cleanZohoText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractZohoListUrl(pageHtml, fallbackUrl) {
  const metaPayload = extractZohoHiddenInputValue(pageHtml, "meta");
  if (metaPayload) {
    try {
      const metaData = JSON.parse(decodeHtmlEntities(metaPayload));
      const listUrl = String(metaData?.list_url || "").trim();
      if (listUrl) return listUrl;
    } catch {
      // Continue to fallback extraction paths.
    }
  }

  const ogMatch = String(pageHtml || "").match(
    /<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i
  );
  const ogUrl = String(ogMatch?.[1] || "").trim();
  if (ogUrl) return decodeHtmlEntities(ogUrl);

  const parsed = parseUrl(fallbackUrl);
  if (parsed?.protocol && parsed?.host) {
    return `${parsed.protocol}//${parsed.host}/jobs/Careers`;
  }
  return String(fallbackUrl || "").trim();
}

function buildZohoJobUrl(listUrl, jobId) {
  const parsed = parseUrl(listUrl);
  if (!parsed?.protocol || !parsed?.host) return String(listUrl || "").trim();

  let normalizedPath = String(parsed.pathname || "").replace(/\/+$/, "");
  if (!normalizedPath) normalizedPath = "/jobs/Careers";
  if (!normalizedPath.toLowerCase().includes("/jobs/careers")) {
    normalizedPath = "/jobs/Careers";
  }

  return `${parsed.protocol}//${parsed.host}${normalizedPath}/${encodeURIComponent(String(jobId || "").trim())}`;
}

function parseZohoPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const rawJobsPayload = extractZohoHiddenInputValue(pageHtml, "jobs");
  if (!rawJobsPayload) return [];

  let jobs = [];
  try {
    const parsed = JSON.parse(decodeHtmlEntities(rawJobsPayload));
    if (Array.isArray(parsed)) {
      jobs = parsed;
    }
  } catch {
    return [];
  }

  const listUrl = extractZohoListUrl(pageHtml, config?.careersUrl || config?.origin || "");
  const postings = [];
  const seenIds = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    if (job?.Publish === false) continue;

    const jobId = String(job?.id || "").trim();
    if (!jobId || seenIds.has(jobId)) continue;

    const title = cleanZohoText(job?.Posting_Title) || cleanZohoText(job?.Job_Opening_Name) || "Untitled Position";
    const city = cleanZohoText(job?.City);
    const state = cleanZohoText(job?.State);
    const country = cleanZohoText(job?.Country);
    const location = [city, state, country].filter(Boolean).join(", ") || null;
    const postingDate = cleanZohoText(job?.Date_Opened);

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: buildZohoJobUrl(listUrl, jobId),
      posting_date: postingDate || null,
      location,
      department: cleanZohoText(job?.Industry) || null
    });
    seenIds.add(jobId);
  }

  return postings;
}



async function fetchZohoCareersPage(urlString) {
  const res = await fetchWithAtsRateLimit("zoho", ZOHO_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoho Recruit page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}



module.exports = { collectPostingsForZohoCompany, parseZohoCompany };
