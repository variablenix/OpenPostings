const { parseUrl, urljoin, cleanHtmlText } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const JOBS2WEB_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;


function parseJobs2webCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".jobs2web.com")) return null;
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  return {
    host,
    searchUrl: `${baseOrigin}/search/`
  };
}

function parseJobs2webPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const rowPattern = /<tr[^>]*class=['"][^'"]*\bdata-row\b[^'"]*['"][^>]*>(?<row>[\s\S]*?)<\/tr>/gi;
  const titlePattern = /<a[^>]*href=['"](?<href>[^'"]+)['"][^>]*class=['"][^'"]*\bjobTitle-link\b[^'"]*['"][^>]*>(?<title>[\s\S]*?)<\/a>/i;
  const locationPattern = /<td[^>]*class=['"][^'"]*\bcolLocation\b[^'"]*['"][^>]*>(?<location>[\s\S]*?)<\/td>/i;
  const datePattern = /<span[^>]*class=['"][^'"]*\bjobDate\b[^'"]*['"][^>]*>(?<date>[\s\S]*?)<\/span>/i;

  let rowMatch = rowPattern.exec(source);
  while (rowMatch) {
    const rowHtml = String(rowMatch.groups?.row || "");
    const titleMatch = titlePattern.exec(rowHtml);
    if (!titleMatch) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const postingUrl = urljoin(pageUrl, cleanHtmlText(titleMatch.groups?.href || ""));
    if (!postingUrl || seenUrls.has(postingUrl)) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const positionName = cleanHtmlText(titleMatch.groups?.title || "") || "Untitled Position";
    const location = cleanHtmlText(locationPattern.exec(rowHtml)?.groups?.location || "") || null;
    const postingDate = cleanHtmlText(datePattern.exec(rowHtml)?.groups?.date || "") || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName,
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(postingUrl);
    rowMatch = rowPattern.exec(source);
  }

  return postings;
}

function extractJobs2webNextStartrow(pageHtml) {
  const source = String(pageHtml || "");
  const nextLinkPattern = /<li[^>]*>\s*<a[^>]*href=["'][^"']*startrow=(?<startrow>\d+)[^"']*["'][^>]*title=["'][^"']*(?:Page\s+\d+|Next)[^"']*["'][^>]*>/gi;
  let maxStartrow = null;
  let match = nextLinkPattern.exec(source);
  while (match) {
    const startrow = Number(match.groups?.startrow);
    if (Number.isFinite(startrow)) {
      maxStartrow = maxStartrow === null ? startrow : Math.max(maxStartrow, startrow);
    }
    match = nextLinkPattern.exec(source);
  }
  return maxStartrow;
}

async function collectPostingsForJobs2webCompany(company) {
  const config = parseJobs2webCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "jobs2web";

  const postings = [];
  const seenUrls = new Set();
  let startrow = 0;

  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_COMPANY; pageIndex += 1) {
    const requestUrl = new URL(config.searchUrl);
    requestUrl.searchParams.set("q", "");
    if (startrow > 0) {
      requestUrl.searchParams.set("startrow", String(startrow));
    }

    const response = await fetchWithAtsRateLimit("jobs2web", JOBS2WEB_RATE_LIMIT_WAIT_MS, requestUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jobs2Web request failed (${response.status}): ${body.slice(0, 180)}`);
    }

    const pageHtml = await response.text();
    const finalUrl = String(response.url || requestUrl.toString()).trim();
    const batch = parseJobs2webPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
    if (!batch.length) break;

    let added = 0;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      postings.push(posting);
      added += 1;
    }
    if (!added) break;

    const nextStartrow = extractJobs2webNextStartrow(pageHtml);
    if (!Number.isFinite(nextStartrow) || nextStartrow <= startrow) break;
    startrow = nextStartrow;
  }

  return postings;
}

module.exports = { collectPostingsForJobs2webCompany, parseJobs2webCompany };