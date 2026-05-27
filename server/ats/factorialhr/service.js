const { parseUrl, cleanHtmlText, urljoin, normalizeLikeText } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const FACTORIALHR_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseFactorialhrCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".factorialhr.com") || host === "factorialhr.com") return null;
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  return {
    host,
    boardUrl: `${baseOrigin}/#jobs`
  };
}

function extractFactorialhrDateFromJobHtml(jobHtml) {
  const source = String(jobHtml || "");
  const patterns = [
    /"datePosted"\s*:\s*"(?<value>[^"]+)"/i,
    /"datePublished"\s*:\s*"(?<value>[^"]+)"/i,
    /data-posted-at=["'](?<value>[^"']+)["']/i,
    /posted\s*(?:on|at)?\s*[:\-]?\s*(?<value>\d{4}-\d{2}-\d{2})/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    const value = String(match?.groups?.value || "").trim();
    if (value) return value;
  }
  return null;
}

function extractFactorialhrLocationFromJobHtml(jobHtml) {
  const source = String(jobHtml || "");
  const labeledMatch = /<strong>\s*location\s*:\s*(?<value>[\s\S]*?)<\/strong>/i.exec(source);
  const labeledValue = cleanHtmlText(labeledMatch?.groups?.value || "");
  if (labeledValue) return labeledValue;

  const candidates = [];
  const spanPattern = /<span[^>]*class=['"][^'"]*inline-block[^'"]*align-middle[^'"]*['"][^>]*>(?<value>[\s\S]*?)<\/span>/gi;
  let spanMatch = spanPattern.exec(source);
  while (spanMatch) {
    const value = cleanHtmlText(spanMatch?.groups?.value || "");
    if (value) candidates.push(value);
    spanMatch = spanPattern.exec(source);
  }

  const blocked = new Set([
    "permanent",
    "temporary",
    "contract",
    "full time",
    "part time",
    "internship",
    "marketing",
    "engineering",
    "sales",
    "operations",
    "finance",
    "human resources",
    "hr",
    "general"
  ]);

  const looksLikeLocation = (value) => {
    if (/,/.test(value)) return true;
    if (/\b(?:united kingdom|england|scotland|wales|northern ireland|canada|usa|united states)\b/i.test(value)) {
      return true;
    }
    if (/\b[A-Z]{1,3}\d[A-Z\d]?\b/.test(value)) return true;
    return /\d/.test(value) && /\s/.test(value);
  };

  for (const value of candidates) {
    const normalized = normalizeLikeText(value);
    if (!normalized || blocked.has(normalized)) continue;
    if (looksLikeLocation(value)) return value;
  }

  for (const value of candidates) {
    const normalized = normalizeLikeText(value);
    if (!normalized || blocked.has(normalized)) continue;
    return value;
  }

  return null;
}

function extractFactorialhrDescriptionFromJobHtml(jobHtml) {
  const source = String(jobHtml || "");
  const styledTextMatch = /<div[^>]*class=['"][^'"]*\bstyledText\b[^'"]*['"][^>]*>(?<value>[\s\S]*?)<\/div>\s*<\/div>/i.exec(source);
  const styledText = cleanHtmlText(styledTextMatch?.groups?.value || "");
  if (styledText) return styledText;

  const fallbackMeta = /<meta[^>]*property=['"]og:description['"][^>]*content=['"](?<value>[^'"]+)['"]/i.exec(source);
  const fallbackDescription = cleanHtmlText(fallbackMeta?.groups?.value || "");
  return fallbackDescription || null;
}

function parseFactorialhrPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const cardPattern = /<li[^>]*class=['"][^'"]*\bjob-offer-item\b[^'"]*['"][^>]*>[\s\S]*?<\/li>/gi;
  const urlPattern = /data-job-postings-url=['"](?<url>[^'"]+)['"]/i;
  const titlePattern = /<div[^>]*factorial__headingFontFamily[^>]*>(?<title>[\s\S]*?)<\/div>/i;
  const locationPattern = /<div[^>]*text-gray-350[^>]*>(?<location>[\s\S]*?)<\/div>/i;

  let cardMatch = cardPattern.exec(source);
  while (cardMatch) {
    const cardHtml = String(cardMatch[0] || "");
    const urlMatch = urlPattern.exec(cardHtml);
    if (!urlMatch) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const rawUrl = cleanHtmlText(urlMatch.groups?.url || "");
    const jobPostingUrl = urljoin(pageUrl, rawUrl);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const title = cleanHtmlText((titlePattern.exec(cardHtml)?.groups?.title || "").trim()) || "Untitled Position";
    if (normalizeLikeText(title) === "open application") {
      cardMatch = cardPattern.exec(source);
      continue;
    }
    const location = cleanHtmlText(locationPattern.exec(cardHtml)?.groups?.location || "") || null;
    const remoteFlagRaw = cleanHtmlText(/data-is-remote=['"](?<v>[^'"]+)['"]/i.exec(cardHtml)?.groups?.v || "");
    const remoteFlag = normalizeLikeText(remoteFlagRaw);
    const remoteLabel = remoteFlag === "true" ? "Remote" : null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: jobPostingUrl,
      posting_date: null,
      location: location || remoteLabel,
      job_description: null
    });
    seenUrls.add(jobPostingUrl);
    cardMatch = cardPattern.exec(source);
  }

  return postings;
}

async function collectPostingsForFactorialhrCompany(company) {
  const config = parseFactorialhrCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "factorialhr";

  const boardResponse = await fetchWithAtsRateLimit("factorialhr", FACTORIALHR_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!boardResponse.ok) {
    const body = await boardResponse.text();
    throw new Error(`FactorialHR board request failed (${boardResponse.status}): ${body.slice(0, 180)}`);
  }

  const boardHtml = await boardResponse.text();
  const finalUrl = String(boardResponse.url || config.boardUrl).trim();
  const postings = parseFactorialhrPostingsFromHtml(companyNameForPostings, boardHtml, finalUrl);

  for (const posting of postings) {
    const jobUrl = String(posting?.job_posting_url || "").trim();
    if (!jobUrl) continue;
    try {
      const detailResponse = await fetchWithAtsRateLimit("factorialhr", FACTORIALHR_RATE_LIMIT_WAIT_MS, jobUrl, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        }
      });
      if (!detailResponse.ok) continue;
      const detailHtml = await detailResponse.text();
      const detailLocation = extractFactorialhrLocationFromJobHtml(detailHtml);
      if (detailLocation) posting.location = detailLocation;
      const detailDescription = extractFactorialhrDescriptionFromJobHtml(detailHtml);
      if (detailDescription) posting.job_description = detailDescription;
      const date = extractFactorialhrDateFromJobHtml(detailHtml);
      if (date) posting.posting_date = date;
    } catch (_error) {
      // Best-effort date extraction; keep posting even if detail page parse fails.
    }
  }

  return postings;
}

module.exports = { collectPostingsForFactorialhrCompany, parseFactorialhrCompany };
