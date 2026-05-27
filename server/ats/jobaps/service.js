const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const JOBAPS_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForJobApsCompany(company) {
  const config = parseJobApsCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const hostPrefix = String(config.host || "").split(".")[0];
  const companyNameForPostings = normalizedCompanyName || String(hostPrefix || "").toLowerCase();
  const { pageHtml, finalUrl } = await fetchJobApsCareersPage(config.boardUrl);
  return parseJobApsPostingsFromHtml(companyNameForPostings, config, pageHtml, finalUrl || config.boardUrl);
}


function parseJobApsCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".jobapscloud.com")) return null;

  const boardUrl = parsed.toString();
  return {
    host,
    boardUrl
  };
}


function cleanJobApsText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function parseJobApsPostingsFromHtml(companyNameForPostings, _config, pageHtml, baseUrl) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const ignoredTitles = new Set(["application-on-file", "application on-file", "application on file", "applicant profile"]);

  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const titleLinkPattern =
    /<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"][^'"]*\bJobTitle\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i;
  const jobNumPattern =
    /<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"][^'"]*\bJobNum\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i;
  const locationPattern = /<td[^>]*class=['"][^'"]*\bLocs\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i;
  const departmentPattern = /<td[^>]*class=['"][^'"]*\bDept\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i;
  const salaryPattern = /<td[^>]*class=['"][^'"]*\bSalary\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i;

  let rowMatch = rowPattern.exec(source);
  while (rowMatch) {
    const rowHtml = String(rowMatch[1] || "");
    const titleMatch = rowHtml.match(titleLinkPattern);
    if (!titleMatch?.[1]) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const href = decodeHtmlEntities(String(titleMatch[1] || "").trim());
    const title = cleanJobApsText(titleMatch[2] || "") || "Untitled Position";
    if (!href) {
      rowMatch = rowPattern.exec(source);
      continue;
    }
    if (href.toLowerCase().includes("r1=af")) {
      rowMatch = rowPattern.exec(source);
      continue;
    }
    if (ignoredTitles.has(title.toLowerCase())) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const jobNumValue = cleanJobApsText(rowHtml.match(jobNumPattern)?.[2] || "");
    if (!jobNumValue || jobNumValue.toLowerCase() === "update at any time") {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(href, String(baseUrl || "")).toString();
    } catch {
      rowMatch = rowPattern.exec(source);
      continue;
    }
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const location = cleanJobApsText(rowHtml.match(locationPattern)?.[1] || "");
    const department = cleanJobApsText(rowHtml.match(departmentPattern)?.[1] || "");
    const salary = cleanJobApsText(rowHtml.match(salaryPattern)?.[1] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null,
      department: department || null,
      salary: salary || null,
      external_id: jobNumValue || null
    });
    seenUrls.add(absoluteUrl);
    rowMatch = rowPattern.exec(source);
  }

  return postings;
}


async function fetchJobApsCareersPage(urlString) {
  const res = await fetchWithAtsRateLimit("jobaps", JOBAPS_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`JobAps page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".jobapscloud.com")) {
    throw new Error(`JobAps URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}


module.exports = { collectPostingsForJobApsCompany, parseJobApsCompany };