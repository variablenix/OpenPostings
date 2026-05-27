

const { parseUrl, urljoin, decodeHtmlEntities, stripHtml, toCleanString, extractCompanyNameFromUrlString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const TRAKSTAR_RATE_LIMIT_WAIT_MS = 60 * 1000;

function normalizeLocationPart(value) {
  return String(decodeHtmlEntities(stripHtml(value || "")) || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocationBySpanClass(source, className) {
  const pattern = new RegExp(
    `<span[^>]*class=(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>(?<value>[\\s\\S]*?)<\\/span>`,
    "i"
  );
  return normalizeLocationPart(pattern.exec(String(source || ""))?.groups?.value || "");
}

function extractTrakstarLocation(blockHtml) {
  const blockSource = String(blockHtml || "");
  const cityFromBlock = extractLocationBySpanClass(blockSource, "meta-job-location-city");
  const stateFromBlock = extractLocationBySpanClass(blockSource, "meta-job-location-state");
  const countryFromBlock = extractLocationBySpanClass(blockSource, "meta-job-location-country");
  const partsFromBlock = [cityFromBlock, stateFromBlock, countryFromBlock].filter(Boolean);
  if (partsFromBlock.length > 0) {
    return partsFromBlock.join(", ");
  }

  const locationDivTitlePattern =
    /<div[^>]*class=(?:"[^"]*\bjs-job-list-opening-loc\b[^"]*"|'[^']*\bjs-job-list-opening-loc\b[^']*')[^>]*\btitle=(?:"(?<value>[^"]*)"|'(?<valueSingle>[^']*)')[^>]*>/i;
  const titleLocationMatch = locationDivTitlePattern.exec(blockSource);
  const titleLocation = normalizeLocationPart(
    titleLocationMatch?.groups?.value || titleLocationMatch?.groups?.valueSingle || ""
  );
  if (titleLocation) return titleLocation;

  const locationBlockPattern =
    /<div[^>]*class=(?:"[^"]*\bjs-job-list-opening-loc\b[^"]*"|'[^']*\bjs-job-list-opening-loc\b[^']*')[^>]*>(?<location>[\s\S]*?)<\/div>/i;
  const locationBlockHtml = String(locationBlockPattern.exec(blockSource)?.groups?.location || "");
  if (!locationBlockHtml) return null;

  const city = extractLocationBySpanClass(locationBlockHtml, "meta-job-location-city");
  const state = extractLocationBySpanClass(locationBlockHtml, "meta-job-location-state");
  const country = extractLocationBySpanClass(locationBlockHtml, "meta-job-location-country");

  const parts = [city, state, country].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(", ");
  }

  const fallback = normalizeLocationPart(locationBlockHtml).replace(/\s*,\s*/g, ", ");
  return fallback || null;
}

function parseTrakstarCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  const isValidHost =
    host.endsWith(".hire.trakstar.com") ||
    host.endsWith(".recruiterbox.com") ||
    host.endsWith(".trakstarhire.com");
  if (!isValidHost) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}${parsed.pathname || "/"}`;
  return { host, boardUrl };
}

function parseTrakstarPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return [];

  const postings = [];
  const seenUrls = new Set();
  const blockPattern =
    /<div[^>]*class="[^"]*\bjs-careers-page-job-list-item\b[^"]*"[^>]*>(?<block>[\s\S]*?)<\/div>\s*<\/div>/gi;
  const hrefPattern = /<a[^>]*href="(?<href>\/jobs\/[^"]+\/?)"[^>]*>/i;
  const titlePattern =
    /<h3[^>]*class="[^"]*\bjs-job-list-opening-name\b[^"]*"[^>]*>(?<title>[\s\S]*?)<\/h3>/i;
  const metaPattern =
    /<div[^>]*class="[^"]*\bjs-job-list-opening-meta\b[^"]*"[^>]*>(?<meta>[\s\S]*?)<\/div>/i;

  let match = blockPattern.exec(source);
  while (match) {
    const block = String(match.groups?.block || "");
    const hrefMatch = hrefPattern.exec(block);
    if (!hrefMatch) {
      match = blockPattern.exec(source);
      continue;
    }

    const postingUrl = urljoin(pageUrl, decodeHtmlEntities(String(hrefMatch.groups?.href || "")));
    if (!postingUrl || seenUrls.has(postingUrl)) {
      match = blockPattern.exec(source);
      continue;
    }

    const title = stripHtml(titlePattern.exec(block)?.groups?.title || "") || "Untitled Position";
    const location = extractTrakstarLocation(block);
    const postingDate = stripHtml(metaPattern.exec(block)?.groups?.meta || "") || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(postingUrl);
    match = blockPattern.exec(source);
  }

  return postings;
}

async function collectPostingsForTrakstarCompany(company) {
  const config = parseTrakstarCompany(company.url_string);
  if (!config) return [];

  const companyNameForPostings =
    toCleanString(company.company_name) || extractCompanyNameFromUrlString(config.host) || config.host;

  const res = await fetchWithAtsRateLimit("trakstar", TRAKSTAR_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  const lower = String(pageHtml || "").toLowerCase();
  if (lower.includes("inactive account.") || lower.includes("recruiterbox.com/inactive-ats")) {
    return [];
  }
  const finalUrl = String(res.url || config.boardUrl).trim();
  return parseTrakstarPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
}

module.exports = { collectPostingsForTrakstarCompany, parseTrakstarCompany };
