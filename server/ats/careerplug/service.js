const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const CAREERPLUG_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForCareerplugCompany(company) {
  const config = parseCareerplugCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const pageHtml = await fetchCareerplugJobsPage(config.jobsUrl);
  return parseCareerplugPostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function cleanCareerplugText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function normalizeCareerplugMeta(value) {
  return cleanCareerplugText(value)
    .replace(/^\s*Location:\s*/i, "")
    .replace(/^\s*Full\s*\/\s*Part\s*Time:\s*/i, "")
    .trim();
}

function parseCareerplugPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const rowPattern =
    /<a[^>]*\baria-label=["'][^"']*["'][^>]*\bhref=["'](\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<div[^>]*class=["'][^"']*\bjob-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const locationPattern = /<div[^>]*class=["'][^"']*\bjob-location\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const typePattern = /<div[^>]*class=["'][^"']*\bjob-type\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

  let rowMatch = rowPattern.exec(source);
  while (rowMatch) {
    const href = String(rowMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const rowBody = String(rowMatch[2] || "");
    const title = cleanCareerplugText(rowBody.match(titlePattern)?.[1] || "");
    const location = normalizeCareerplugMeta(rowBody.match(locationPattern)?.[1] || "");
    const jobType = normalizeCareerplugMeta(rowBody.match(typePattern)?.[1] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null,
      employment_type: jobType || null
    });
    seenUrls.add(absoluteUrl);
    rowMatch = rowPattern.exec(source);
  }

  return postings;
}

function parseCareerplugCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".careerplug.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    jobsUrl: `${parsed.protocol}//${parsed.host}/jobs`
  };
}

async function fetchCareerplugJobsPage(urlString) {
  const res = await fetchWithAtsRateLimit("careerplug", CAREERPLUG_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CareerPlug page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}


module.exports = { collectPostingsForCareerplugCompany, parseCareerplugCompany };