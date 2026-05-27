const { parseUrl, stripHtml, urljoin, decodeHtmlEntities, toCleanString, extractCompanyNameFromUrlString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SOFTGARDEN_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseSoftgardenCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".softgarden.io")) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}/vacancies`;
  return { host, boardUrl };
}

function parseSoftgardenPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return [];

  const postings = [];
  const seenUrls = new Set();
  const blockStartPattern =
    /<div[^>]*class="[^"]*\bmatchElement\b[^"]*"[^>]*id="job_id_(?<jobId>\d+)"[^>]*>/gi;
  const hrefPattern = /<a[^>]*href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/i;
  const datePattern = /<div class="matchValue date">(?<date>[\s\S]*?)<\/div>/i;
  const locationPattern = /<div class="matchValue ProjectGeoLocationCity">(?<location>[\s\S]*?)<\/div>/i;
  const locationItemPattern =
    /<span[^>]*class="[^"]*\blocation-view-item\b[^"]*"[^>]*>(?<value>[\s\S]*?)<\/span>/gi;

  const blockStarts = [];
  let blockStartMatch = blockStartPattern.exec(source);
  while (blockStartMatch) {
    const startIndex = Number(blockStartMatch.index);
    if (Number.isFinite(startIndex) && startIndex >= 0) {
      blockStarts.push(startIndex);
    }
    blockStartMatch = blockStartPattern.exec(source);
  }

  for (let index = 0; index < blockStarts.length; index += 1) {
    const startIndex = blockStarts[index];
    const endIndex = index + 1 < blockStarts.length ? blockStarts[index + 1] : source.length;
    const block = String(source.slice(startIndex, endIndex) || "");
    if (!block) continue;

    const hrefMatch = hrefPattern.exec(block);
    if (!hrefMatch) {
      continue;
    }

    const postingUrl = urljoin(pageUrl, decodeHtmlEntities(String(hrefMatch.groups?.href || "")));
    if (!postingUrl || seenUrls.has(postingUrl)) {
      continue;
    }

    const title = stripHtml(hrefMatch.groups?.title || "") || "Untitled Position";
    const postingDate = stripHtml(datePattern.exec(block)?.groups?.date || "") || null;
    const locationItems = Array.from(block.matchAll(locationItemPattern))
      .map((parts) => String(stripHtml(parts?.groups?.value || "") || "").replace(/,\s*$/g, "").trim())
      .filter(Boolean);
    const location =
      (locationItems.length > 0 ? locationItems.join(", ") : null) ||
      stripHtml(locationPattern.exec(block)?.groups?.location || "") ||
      null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}

async function collectPostingsForSoftgardenCompany(company) {
  const config = parseSoftgardenCompany(company.url_string);
  if (!config) return [];

  const companyNameForPostings =
    toCleanString(company.company_name) || extractCompanyNameFromUrlString(config.host) || config.host;
  const res = await fetchWithAtsRateLimit("softgarden", SOFTGARDEN_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  const finalUrl = String(res.url || config.boardUrl).trim();
  return parseSoftgardenPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
}

module.exports = { collectPostingsForSoftgardenCompany, parseSoftgardenCompany };
