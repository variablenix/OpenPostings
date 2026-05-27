const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const APPLYTOJOB_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForApplyToJobCompany(company) {
  const config = parseApplyToJobCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const pageHtml = await fetchApplyToJobPage(config.applyUrl);
  return parseApplyToJobPostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function parseApplyToJobCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".applytojob.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    applyUrl: `${parsed.protocol}//${parsed.host}/apply`
  };
}


function cleanApplyToJobText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseApplyToJobPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const listItemPattern =
    /<li[^>]*class=["'][^"']*\blist-group-item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  const listHeadingPattern =
    /<h3[^>]*class=["'][^"']*\blist-group-item-heading\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
  const listLocationPattern = /fa-map-marker[^>]*><\/i>\s*([^<]+)/i;

  let listItemMatch = listItemPattern.exec(source);
  while (listItemMatch) {
    const itemHtml = String(listItemMatch[1] || "");
    const headingMatch = itemHtml.match(listHeadingPattern);
    if (!headingMatch?.[1]) {
      listItemMatch = listItemPattern.exec(source);
      continue;
    }

    const href = String(headingMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      listItemMatch = listItemPattern.exec(source);
      continue;
    }

    const locationMatch = itemHtml.match(listLocationPattern);
    const location = locationMatch?.[1] ? cleanApplyToJobText(locationMatch[1]) : null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: cleanApplyToJobText(headingMatch[2]) || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location
    });
    seenUrls.add(absoluteUrl);

    listItemMatch = listItemPattern.exec(source);
  }

  const legacyLinkPattern =
    /<a(?=[^>]*\bresumator-job-title-link\b)(?=[^>]*href=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi;
  const legacyLocationPattern =
    /<span[^>]*class=["'][^"']*\bresumator-job-location\b[^"']*["'][^>]*>\s*Location:\s*<\/span>\s*([^<]*)/i;

  const legacyMatches = Array.from(source.matchAll(legacyLinkPattern));
  for (let index = 0; index < legacyMatches.length; index += 1) {
    const match = legacyMatches[index];
    const href = String(match?.[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) continue;

    const nextStart = index + 1 < legacyMatches.length ? Number(legacyMatches[index + 1].index || 0) : source.length;
    const currentEnd = Number(match.index || 0) + String(match[0] || "").length;
    const searchEnd = Math.min(nextStart, currentEnd + 2500);
    const contextHtml = source.slice(currentEnd, searchEnd);
    const locationMatch = contextHtml.match(legacyLocationPattern);
    const location = locationMatch?.[1] ? cleanApplyToJobText(locationMatch[1]) : null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: cleanApplyToJobText(match?.[2]) || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location
    });
    seenUrls.add(absoluteUrl);
  }

  return postings;
}

async function fetchApplyToJobPage(applyUrl) {
  const res = await fetchWithAtsRateLimit("applytojob", APPLYTOJOB_RATE_LIMIT_WAIT_MS, applyUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ApplyToJob page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

module.exports = { collectPostingsForApplyToJobCompany, parseApplyToJobCompany };
