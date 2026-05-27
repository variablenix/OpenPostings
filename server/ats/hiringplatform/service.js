const { parseUrl, urljoin, cleanHtmlText } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HIRINGPLATFORM_RATE_LIMIT_WAIT_MS = 60 * 1000;

function cleanHiringplatformMultilineText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchHiringplatformPostingDetail(detailUrl) {
  const url = String(detailUrl || "").trim();
  if (!url) {
    return { location: null, job_description: null };
  }

  const response = await fetchWithAtsRateLimit("hiringplatform", HIRINGPLATFORM_RATE_LIMIT_WAIT_MS, url, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!response.ok) {
    return { location: null, job_description: null };
  }

  const html = String(await response.text() || "");
  if (!html) {
    return { location: null, job_description: null };
  }

  const locationFromList = cleanHtmlText(
    html.match(/fa-location-dot[\s\S]{0,1200}?<li>([\s\S]*?)<\/li>/i)?.[1] || ""
  );
  const locationFromTitle = cleanHtmlText(
    html.match(/<p[^>]*class=["'][^"']*\bvidcruiter-job-item-description-title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || ""
  );
  const location = locationFromList || locationFromTitle || null;

  const descriptionHtml =
    html.match(
      /<p[^>]*class=["'][^"']*\bvidcruiter-job-item-description-text\b[^"']*["'][^>]*>([\s\S]*?)<\/p>\s*<div[^>]*class=["'][^"']*\bvidcruiter-job-board-individual-content\b/i
    )?.[1] ||
    html.match(/<h3[^>]*>\s*Job Description\s*<\/h3>([\s\S]*?)(?:<h3[^>]*>|<\/p>\s*<div[^>]*vidcruiter-job-board-individual-content)/i)?.[1] ||
    "";
  const jobDescription = cleanHiringplatformMultilineText(descriptionHtml) || null;

  return { location, job_description: jobDescription };
}


function parseHiringplatformCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".hiringplatform.com")) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}${parsed.pathname || "/"}${parsed.search || ""}`;
  return { host, boardUrl };
}

function parseHiringplatformPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const cardPattern = /<div[^>]*class=["'][^"']*\bvidcruiter-job-item\b[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
  const applyUrlPattern = /<a[^>]*class=["'][^"']*\bvidcruiter-btn\b[^"']*["'][^>]*href=["'](?<href>[^"']+)["'][^>]*>\s*Apply\s*<\/a>/i;
  const titlePattern = /<h2[^>]*class=["'][^"']*\bvidcruiter-job-item-title\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["'](?<href>[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>[\s\S]*?<\/h2>/i;
  const locationPattern = /<p[^>]*class=["'][^"']*\bvidcruiter-job-item-description-title\b[^"']*["'][^>]*>(?<location>[\s\S]*?)<\/p>/i;

  let cardMatch = cardPattern.exec(source);
  while (cardMatch) {
    const cardHtml = String(cardMatch[0] || "");
    const applyMatch = applyUrlPattern.exec(cardHtml);
    if (!applyMatch?.groups?.href) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const titleMatch = titlePattern.exec(cardHtml);
    const detailUrl = urljoin(pageUrl, cleanHtmlText(titleMatch?.groups?.href || ""));
    const postingUrl = urljoin(pageUrl, cleanHtmlText(applyMatch.groups.href));
    if (!postingUrl || seenUrls.has(postingUrl) || !postingUrl.includes(".hiringplatform.com/")) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const title = cleanHtmlText(titleMatch?.groups?.title || "") || "Untitled Position";
    const location = cleanHtmlText(locationPattern.exec(cardHtml)?.groups?.location || "") || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: null,
      location,
      _detail_page_url: detailUrl || null
    });
    seenUrls.add(postingUrl);
    cardMatch = cardPattern.exec(source);
  }

  return postings;
}

async function collectPostingsForHiringplatformCompany(company) {
  const config = parseHiringplatformCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "hiringplatform";

  const response = await fetchWithAtsRateLimit("hiringplatform", HIRINGPLATFORM_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`HiringPlatform request failed (${response.status}): ${body.slice(0, 180)}`);
  }

  const pageHtml = await response.text();
  const finalUrl = String(response.url || config.boardUrl).trim();
  const postings = parseHiringplatformPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);

  for (const posting of postings) {
    const detailUrl = String(posting?._detail_page_url || posting?.job_posting_url || "").trim();
    if (!detailUrl) continue;
    try {
      const detail = await fetchHiringplatformPostingDetail(detailUrl);
      if (String(detail?.location || "").trim()) {
        posting.location = detail.location;
      }
      if (String(detail?.job_description || "").trim()) {
        posting.job_description = detail.job_description;
      }
    } catch {
      // Keep board posting when detail page is unavailable.
    }
    delete posting._detail_page_url;
  }

  return postings;
}

module.exports = { collectPostingsForHiringplatformCompany, parseHiringplatformCompany };
