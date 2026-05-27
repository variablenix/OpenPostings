const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const JOBVITE_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForJobviteCompany(company) {
  const config = parseJobviteCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings =
    normalizedCompanyName &&
    normalizedCompanyName.toLowerCase() !== "jobs" &&
    normalizedCompanyName.toLowerCase() !== "careers"
      ? normalizedCompanyName
      : config.companySlugLower;

  const pageHtml = await fetchJobviteJobsPage(config.jobsUrl);
  return parseJobvitePostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function parseJobviteCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "jobs.jobvite.com" && host !== "careers.jobvite.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const companySlug = String(pathParts[0] || "").trim();
  if (!companySlug) return null;

  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    jobsUrl: `${parsed.protocol}//${parsed.host}/${companySlug}/jobs`
  };
}



function cleanJobviteText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function parseJobvitePostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const tablePattern =
    /<h3[^>]*>([\s\S]*?)<\/h3>\s*<table[^>]*class=["'][^"']*\bjv-job-list\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;
  const rowPattern =
    /<tr[^>]*>[\s\S]*?<td[^>]*class=["'][^"']*\bjv-job-list-name\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/td>[\s\S]*?<td[^>]*class=["'][^"']*\bjv-job-list-location\b[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;

  const postings = [];
  const seenUrls = new Set();

  const pushRows = (rowsHtml, department = "") => {
    let rowMatch = rowPattern.exec(rowsHtml);
    while (rowMatch) {
      const href = String(rowMatch[1] || "").trim();
      const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
      if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
        rowMatch = rowPattern.exec(rowsHtml);
        continue;
      }

      postings.push({
        company_name: companyNameForPostings,
        position_name: cleanJobviteText(rowMatch[2]) || "Untitled Position",
        job_posting_url: absoluteUrl,
        posting_date: null,
        location: cleanJobviteText(rowMatch[3]) || null,
        department: cleanJobviteText(department) || null
      });
      seenUrls.add(absoluteUrl);
      rowMatch = rowPattern.exec(rowsHtml);
    }
    rowPattern.lastIndex = 0;
  };

  let tableMatch = tablePattern.exec(source);
  while (tableMatch) {
    pushRows(String(tableMatch[2] || ""), String(tableMatch[1] || ""));
    tableMatch = tablePattern.exec(source);
  }

  if (postings.length === 0) {
    pushRows(source, "");
  }

  return postings;
}

async function fetchJobviteJobsPage(jobsUrl) {
  const res = await fetchWithAtsRateLimit("jobvite", JOBVITE_RATE_LIMIT_WAIT_MS, jobsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jobvite request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

module.exports = { collectPostingsForJobviteCompany, parseJobviteCompany };
