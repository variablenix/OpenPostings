const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const ICIMS_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

async function collectPostingsForIcimsCompany(company) {
  const config = parseIcimsCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;

  const wrapperHtml = await fetchIcimsPage(config.searchUrl);
  let pageUrl = extractIcimsIframeUrlFromHtml(wrapperHtml, config.searchUrl);
  const collected = [];
  const seenPostingUrls = new Set();
  const seenPageUrls = new Set();

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const normalizedPageUrl = ensureIcimsIframeUrl(pageUrl);
    if (!normalizedPageUrl || seenPageUrls.has(normalizedPageUrl)) break;
    seenPageUrls.add(normalizedPageUrl);

    const pageHtml = await fetchIcimsPage(normalizedPageUrl);
    const batch = parseIcimsPostingsFromHtml(companyNameForPostings, config, pageHtml);
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenPostingUrls.has(postingUrl)) continue;
      seenPostingUrls.add(postingUrl);
      collected.push(posting);
    }

    const nextPageUrl = extractIcimsNextPageUrlFromHtml(pageHtml, normalizedPageUrl);
    if (!nextPageUrl) break;
    pageUrl = nextPageUrl;
  }

  return collected;
}


function parseIcimsCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".icims.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const searchUrl = new URL(parsed.toString());
  searchUrl.pathname = "/jobs/search";
  if (!searchUrl.searchParams.has("ss")) {
    searchUrl.searchParams.set("ss", "1");
  }
  searchUrl.searchParams.delete("in_iframe");

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    origin: `${parsed.protocol}//${parsed.host}`,
    searchUrl: searchUrl.toString()
  };
}


function cleanIcimsText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}


function ensureIcimsIframeUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return String(urlString || "").trim();
  parsed.searchParams.set("in_iframe", "1");
  return parsed.toString();
}

function extractIcimsIframeUrlFromHtml(pageHtml, baseUrl) {
  const source = String(pageHtml || "");
  const patterns = [
    /icimsFrame\.src\s*=\s*'([^']+)'/i,
    /icimsFrame\.src\s*=\s*"([^"]+)"/i,
    /<iframe[^>]*id=["']icims_content_iframe["'][^>]*src=["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const rawValue = String(match?.[1] || "").trim();
    if (!rawValue) continue;

    let candidate = decodeHtmlEntities(rawValue).replace(/\\\//g, "/");
    if (!candidate) continue;

    if (candidate.startsWith("//")) {
      const parsedBase = parseUrl(baseUrl);
      const protocol = String(parsedBase?.protocol || "https:");
      candidate = `${protocol}${candidate}`;
    } else if (!/^https?:\/\//i.test(candidate)) {
      try {
        candidate = new URL(candidate, baseUrl).toString();
      } catch {
        continue;
      }
    }

    return ensureIcimsIframeUrl(candidate);
  }

  return ensureIcimsIframeUrl(baseUrl);
}

function extractIcimsLocationFromHtml(sourceHtml) {
  const source = String(sourceHtml || "");
  const patterns = [
    /field-label">Location\s*<\/span>\s*<\/dt>\s*<dd[^>]*class=["'][^"']*iCIMS_JobHeaderData[^"']*["'][^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /glyphicons-map-marker[^>]*>[\s\S]*?<\/dt>\s*<dd[^>]*class=["'][^"']*iCIMS_JobHeaderData[^"']*["'][^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    const location = cleanIcimsText(match[1]);
    if (location) return location;
  }

  return null;
}

function extractIcimsPostingDateFromHtml(sourceHtml) {
  const source = String(sourceHtml || "");
  const match = source.match(
    /field-label">Date Posted\s*<\/span>\s*<span[^>]*?(?:title=["']([^"']+)["'])?[^>]*>\s*([^<]*)/i
  );
  const withTitle = String(match?.[1] || "").trim();
  if (withTitle) return withTitle;
  const fallback = cleanIcimsText(match?.[2] || "");
  return fallback || null;
}

function parseIcimsPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const cardPattern = /<li[^>]*class=["'][^"']*iCIMS_JobCardItem[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;

  let cardMatch = cardPattern.exec(source);
  while (cardMatch) {
    const cardHtml = String(cardMatch[1] || "");
    const anchorPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let linkHref = "";
    let linkBody = "";
    let anchorMatch = anchorPattern.exec(cardHtml);
    while (anchorMatch) {
      const href = String(anchorMatch[1] || "").trim();
      if (/\/jobs\/\d+/i.test(href)) {
        linkHref = href;
        linkBody = String(anchorMatch[2] || "");
        break;
      }
      anchorMatch = anchorPattern.exec(cardHtml);
    }

    if (!linkHref) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const absoluteUrl = new URL(linkHref, `${config.origin}/`).toString();
    if (!absoluteUrl || seenUrls.has(absoluteUrl) || absoluteUrl.toLowerCase().includes("/jobs/intro")) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const titleMatch = linkBody.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const positionName = cleanIcimsText(titleMatch?.[1] || linkBody) || "Untitled Position";

    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName,
      job_posting_url: absoluteUrl,
      posting_date: extractIcimsPostingDateFromHtml(cardHtml),
      location: extractIcimsLocationFromHtml(cardHtml)
    });
    seenUrls.add(absoluteUrl);
    cardMatch = cardPattern.exec(source);
  }

  if (postings.length > 0) return postings;

  const fallbackLinkPattern = /<a[^>]*href=["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let fallbackMatch = fallbackLinkPattern.exec(source);
  while (fallbackMatch) {
    const href = String(fallbackMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.origin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl) || absoluteUrl.toLowerCase().includes("/jobs/intro")) {
      fallbackMatch = fallbackLinkPattern.exec(source);
      continue;
    }

    const linkBody = String(fallbackMatch[2] || "");
    const titleMatch = linkBody.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const positionName = cleanIcimsText(titleMatch?.[1] || linkBody) || "Untitled Position";

    const contextStart = Math.max(0, Number(fallbackMatch.index || 0) - 800);
    const contextEnd = Math.min(source.length, Number(fallbackMatch.index || 0) + String(fallbackMatch[0] || "").length + 2200);
    const contextHtml = source.slice(contextStart, contextEnd);

    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName,
      job_posting_url: absoluteUrl,
      posting_date: extractIcimsPostingDateFromHtml(contextHtml),
      location: extractIcimsLocationFromHtml(contextHtml)
    });
    seenUrls.add(absoluteUrl);
    fallbackMatch = fallbackLinkPattern.exec(source);
  }

  return postings;
}

function extractIcimsNextPageUrlFromHtml(pageHtml, currentUrl) {
  const source = String(pageHtml || "");
  const patterns = [
    /<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const rawValue = String(match?.[1] || "").trim();
    if (!rawValue) continue;

    let candidate = decodeHtmlEntities(rawValue).replace(/\\\//g, "/");
    if (!candidate) continue;

    if (candidate.startsWith("//")) {
      const parsedCurrent = parseUrl(currentUrl);
      const protocol = String(parsedCurrent?.protocol || "https:");
      candidate = `${protocol}${candidate}`;
    } else if (!/^https?:\/\//i.test(candidate)) {
      try {
        candidate = new URL(candidate, currentUrl).toString();
      } catch {
        continue;
      }
    }

    const normalizedCandidate = ensureIcimsIframeUrl(candidate);
    if (normalizedCandidate && normalizedCandidate !== String(currentUrl || "").trim()) {
      return normalizedCandidate;
    }
  }

  return null;
}


async function fetchIcimsPage(urlString) {
  const res = await fetchWithAtsRateLimit("icims", ICIMS_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`iCIMS page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

module.exports = { collectPostingsForIcimsCompany, parseIcimsCompany };