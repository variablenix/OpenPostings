const { parseUrl, decodeHtmlEntities, urljoin, toCleanString, extractCompanyNameFromUrlString, stripHtml, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

function parseYelloCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  let host = String(parsed.host || "").toLowerCase();
  if (host.startsWith("contextmenu-")) {
    host = host.slice("contextmenu-".length);
  }
  if (!host.endsWith(".yello.co")) return null;

  const parts = String(parsed.pathname || "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2 || parts[0] !== "job_boards") return null;
  const boardId = String(parts[1] || "").trim();
  if (!boardId) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}/job_boards/${boardId}`;
  return { host, boardId, boardUrl };
}

function parseYelloPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return [];

  const postings = [];
  const seenUrls = new Set();
  const itemPattern = /<li[^>]*class="[^"]*\bsearch-results__item\b[^"]*"[^>]*>(?<item>[\s\S]*?)<\/li>/gi;
  const linkPattern =
    /<a[^>]*class="[^"]*\bsearch-results__req_title\b[^"]*"[^>]*href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/i;
  const postedPattern =
    /<div[^>]*class="[^"]*\bsearch-results__post-time\b[^"]*"[^>]*>(?<posted>[\s\S]*?)<\/div>/i;
  const locationPattern =
    /<span[^>]*class="[^"]*\bsearch-results__location\b[^"]*"[^>]*>(?<location>[\s\S]*?)<\/span>/i;
  const jobInfoPattern =
    /<div[^>]*class="[^"]*\bsearch-results__jobinfo\b[^"]*"[^>]*>(?<jobinfo>[\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*\bsearch-results__post-time\b[^"]*"[^>]*>/i;

  let match = itemPattern.exec(source);
  while (match) {
    const itemHtml = String(match.groups?.item || "");
    const linkMatch = linkPattern.exec(itemHtml);
    if (!linkMatch) {
      match = itemPattern.exec(source);
      continue;
    }

    const href = decodeHtmlEntities(String(linkMatch.groups?.href || ""));
    const postingUrl = urljoin(pageUrl, href);
    if (!postingUrl || seenUrls.has(postingUrl)) {
      match = itemPattern.exec(source);
      continue;
    }

    const title = stripHtml(linkMatch.groups?.title || "") || "Untitled Position";
    const postingDate = stripHtml(postedPattern.exec(itemHtml)?.groups?.posted || "") || null;
    let location = stripHtml(locationPattern.exec(itemHtml)?.groups?.location || "") || null;
    if (!location) {
      const jobInfoHtml = String(jobInfoPattern.exec(itemHtml)?.groups?.jobinfo || "");
      if (jobInfoHtml) {
        const spans = Array.from(jobInfoHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi))
          .map((parts) => stripHtml(parts?.[1] || ""))
          .filter(Boolean);
        const secondSpan = String(spans?.[1] || "").replace(/;+$/g, "").trim();
        if (secondSpan) location = secondSpan;
      }
    }

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(postingUrl);
    match = itemPattern.exec(source);
  }

  return postings;
}

async function collectPostingsForYelloCompany(company) {
  const config = parseYelloCompany(company.url_string);
  if (!config) return [];
  const invalidBoardIds = new Set(["inactive", "er", "job_alerts"]);
  if (invalidBoardIds.has(config.boardId.toLowerCase())) return [];

  const res = await fetchWithAtsRateLimit("yello", 60 * 1000, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  const lower = String(pageHtml || "").toLowerCase();
  if (lower.includes("inactive account") || lower.includes("page not found")) {
    return [];
  }

  const titleMatch = /<title>(?<title>[\s\S]*?)<\/title>/i.exec(pageHtml);
  const titleText = decodeHtmlEntities(String(titleMatch?.groups?.title || ""));
  const companyFromTitle = toCleanString(titleText.split("|", 1)[0] || "");
  const companyNameForPostings =
    companyFromTitle || toCleanString(company?.company_name) || extractCompanyNameFromUrlString(config.host) || config.host;

  const finalUrl = String(res.url || config.boardUrl).trim();
  return parseYelloPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
}

module.exports = { collectPostingsForYelloCompany, parseYelloCompany };
