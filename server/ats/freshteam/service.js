const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const FRESHTEAM_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForFreshteamCompany(company) {
  const config = parseFreshteamCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml, finalUrl } = await fetchFreshteamJobsPage(config);
  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    jobsUrl: finalUrl || config.jobsUrl
  };
  return parseFreshteamPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}


function parseFreshteamCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".freshteam.com")) return null;
  if (host === "freshteam.com" || host === "www.freshteam.com" || host === "assets.freshteam.com") return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length > 0 && String(pathParts[0] || "").toLowerCase() !== "jobs") return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin,
    jobsUrl: `${baseOrigin}/jobs`
  };
}


function cleanFreshteamText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseFreshteamPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const cardPattern =
    /<a[^>]*href=["'](\/jobs\/[^"'#?]+(?:\/[^"'#?]+)?)["'][^>]*class=["'][^"']*\bheading\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<div[^>]*class=["'][^"']*\bjob-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const locationInfoPattern = /<div[^>]*class=["'][^"']*\blocation-info\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const locationAttrPattern = /\bdata-portal-location=["']([^"']*)["']/i;
  const remoteAttrPattern = /\bdata-portal-remote-location=(true|false)\b/i;

  let cardMatch = cardPattern.exec(source);
  while (cardMatch) {
    const href = String(cardMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin || ""}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const cardHtml = String(cardMatch[0] || "");
    const bodyHtml = String(cardMatch[2] || "");
    const title = cleanFreshteamText(bodyHtml.match(titlePattern)?.[1] || "") || "Untitled Position";
    const location = cleanFreshteamText(cardHtml.match(locationAttrPattern)?.[1] || "");
    const locationInfo = cleanFreshteamText(bodyHtml.match(locationInfoPattern)?.[1] || "");
    const isRemoteRaw = String(cardHtml.match(remoteAttrPattern)?.[1] || "").trim().toLowerCase();

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || locationInfo || null,
      location_info: locationInfo || null,
      is_remote: isRemoteRaw === "true" ? 1 : 0
    });

    seenUrls.add(absoluteUrl);
    cardMatch = cardPattern.exec(source);
  }

  return postings;
}

async function fetchFreshteamJobsPage(config) {
  const res = await fetchWithAtsRateLimit("freshteam", FRESHTEAM_RATE_LIMIT_WAIT_MS, config.jobsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Freshteam page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.jobsUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".freshteam.com")) {
    throw new Error(`Freshteam URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForFreshteamCompany, parseFreshteamCompany };