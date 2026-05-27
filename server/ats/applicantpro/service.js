const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const APPLICANTPRO_RATE_LIMIT_WAIT_MS = 60 * 1000;

function extractApplicantProLocationLabel(job) {
  const location = String(job?.jobLocation || "").trim();
  if (location) return location;

  const city = String(job?.city || "").trim();
  const state = String(job?.abbreviation || job?.stateName || "").trim();
  const country = String(job?.iso3 || "").trim();
  const values = [city, state, country].filter(Boolean);
  return values.length > 0 ? values.join(", ") : null;
}


async function fetchApplicantProJobsPage(jobsUrl) {
  const res = await fetchWithAtsRateLimit("applicantpro", APPLICANTPRO_RATE_LIMIT_WAIT_MS, jobsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ApplicantPro page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

async function fetchApplicantProJobsList(config, domainId) {
  const apiUrl = new URL(`${String(config?.origin || "").replace(/\/+$/, "")}/core/jobs/${encodeURIComponent(domainId)}`);
  apiUrl.searchParams.set("getParams", "{}");

  const res = await fetchWithAtsRateLimit("applicantpro", APPLICANTPRO_RATE_LIMIT_WAIT_MS, apiUrl.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ApplicantPro jobs request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const payload = await res.json();
  if (payload && typeof payload === "object" && payload.success === false) {
    const message = String(payload?.message || "Unknown ApplicantPro API error");
    throw new Error(`ApplicantPro jobs API returned success=false: ${message}`);
  }
  return payload;
}

async function collectPostingsForApplicantProCompany(company) {
  const config = parseApplicantProCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const jobsPageHtml = await fetchApplicantProJobsPage(config.jobsUrl);
  const domainId = extractApplicantProDomainId(jobsPageHtml);
  if (!domainId) {
    throw new Error("ApplicantPro domain_id was not found on the jobs page");
  }

  const response = await fetchApplicantProJobsList(config, domainId);
  const jobs = Array.isArray(response?.data?.jobs) ? response.data.jobs : [];
  const collected = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    const rawJobUrl = String(job?.jobUrl || "").trim();
    const fallbackJobId = String(job?.id ?? "").trim();
    const absoluteUrl = rawJobUrl
      ? new URL(rawJobUrl, `${config.origin}/`).toString()
      : fallbackJobId
        ? `${config.origin}/jobs/${encodeURIComponent(fallbackJobId)}`
        : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) continue;

    collected.push({
      company_name: companyNameForPostings,
      position_name: String(job?.title || "").trim() || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: String(job?.startDateRef || "").trim() || null,
      location: extractApplicantProLocationLabel(job)
    });
    seenUrls.add(absoluteUrl);
  }

  return collected;
}

function parseApplicantProCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".applicantpro.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const jobsUrl = `${parsed.protocol}//${parsed.host}/jobs/`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    origin: `${parsed.protocol}//${parsed.host}`,
    jobsUrl
  };
}

function extractApplicantProDomainId(pageHtml) {
  const source = String(pageHtml || "");
  const patterns = [
    /["']domain_id["']\s*:\s*["']?(\d{2,})["']?/i,
    /domain_id\s*=\s*["']?(\d{2,})["']?/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const value = String(match?.[1] || "").trim();
    if (value) return value;
  }

  return "";
}

module.exports = { collectPostingsForApplicantProCompany, parseApplicantProCompany };