const { parseUrl, stripHtml, urljoin, extractCompanyNameFromUrlString, decodeHtmlEntities, toCleanString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const PERSONIO_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parsePersonioCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".jobs.personio.com") || host === "jobs.personio.com") return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}/`;
  return { host, boardUrl };
}

function parsePersonioPostingsFromHtml(html, pageUrl) {
  if (!html) return [];
  const postings = [];
  const seenUrls = new Set();
  const itemRegex =
    /<a[^>]*class=['"][^'"]*\bjob-box\b[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  const titleRegex = /<h3[^>]*class=['"][^'"]*\bjb-title\b[^'"]*['"][^>]*>([\s\S]*?)<\/h3>/i;
  const metaRegex =
    /<span[^>]*class=['"][^'"]*page_jobMetaText[^'"]*['"][^>]*>([\s\S]*?)<\/span>/gi;

  let itemMatch;
  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const postingUrl = urljoin(pageUrl, decodeHtmlEntities(itemMatch[1]));
    if (!postingUrl || seenUrls.has(postingUrl)) continue;
    const block = String(itemMatch[2] || "");
    const titleMatch = block.match(titleRegex);
    const title = titleMatch ? stripHtml(titleMatch[1]) : "Untitled Position";

    const metas = [];
    let metaMatch;
    while ((metaMatch = metaRegex.exec(block)) !== null) {
      const value = stripHtml(metaMatch[1]);
      if (value) metas.push(value);
    }
    metaRegex.lastIndex = 0;

    postings.push({
      position_name: title || "Untitled Position",
      job_posting_url: postingUrl,
      location: metas.length > 0 ? metas[0] : ""
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}

async function fetchPersonioPostingDate(postingUrl) {
  const res = await fetchWithAtsRateLimit("personio", PERSONIO_RATE_LIMIT_WAIT_MS, postingUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return "";
  const detailHtml = await res.text();
  const source = String(detailHtml || "");
  const patterns = [
    /"datePosted"\s*:\s*"([^"]+)"/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /datePosted["']?\s*[:=]\s*["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[1]) {
      const value = toCleanString(match[1]);
      if (value) return value;
    }
  }
  return "";
}

async function collectPostingsForPersonioCompany(company) {
  const config = parsePersonioCompany(company.url_string);
  if (!config) return [];

  const companyNameForPostings =
    toCleanString(company.company_name) || extractCompanyNameFromUrlString(config.host) || config.host;
  const res = await fetchWithAtsRateLimit("personio", PERSONIO_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  const rawPostings = parsePersonioPostingsFromHtml(pageHtml, config.boardUrl);

  const aggregated = [];
  const seen = new Set();
  for (const posting of rawPostings) {
    const postingUrl = toCleanString(posting.job_posting_url);
    if (!postingUrl || seen.has(postingUrl)) continue;
    const postingDate = await fetchPersonioPostingDate(postingUrl);
    aggregated.push({
      company_name: companyNameForPostings,
      position_name: toCleanString(posting.position_name) || "Untitled Position",
      location: toCleanString(posting.location),
      posting_date: toCleanString(postingDate),
      job_posting_url: postingUrl
    });
    seen.add(postingUrl);
  }
  return aggregated;
}

module.exports = { collectPostingsForPersonioCompany, parsePersonioCompany };
