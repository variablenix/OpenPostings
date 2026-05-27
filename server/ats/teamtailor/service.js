const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings")
const { fetchWithAtsRateLimit } = require("../../services/queue")

const TEAMTAILOR_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForTeamtailorCompany(company) {
  const config = parseTeamtailorCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml, finalUrl } = await fetchTeamtailorJobsPage(config);
  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    jobsUrl: finalUrl || config.jobsUrl
  };
  return parseTeamtailorPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}

function parseTeamtailorCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".teamtailor.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin,
    jobsUrl: `${baseOrigin}/jobs`
  };
}

function cleanTeamtailorText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTeamtailorMetaParts(value) {
  const source = String(value || "");
  const parts = [];
  const seen = new Set();
  const spanPattern = /<span[^>]*>([\s\S]*?)<\/span>/gi;
  let spanMatch = spanPattern.exec(source);

  while (spanMatch) {
    const cleaned = cleanTeamtailorText(spanMatch[1] || "");
    const normalized = cleaned.toLowerCase();
    if (cleaned && cleaned !== "·" && cleaned !== "&middot;" && !seen.has(normalized)) {
      parts.push(cleaned);
      seen.add(normalized);
    }
    spanMatch = spanPattern.exec(source);
  }

  return parts;
}

function parseTeamtailorPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const itemPattern =
    /<li[^>]*class=["'][^"']*\bblock-grid-item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  const hrefPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>/i;
  const titleAttrPattern =
    /<span[^>]*class=["'][^"']*\btext-block-base-link\b[^"']*["'][^>]*\btitle=["']([^"']+)["'][^>]*>/i;
  const titleBodyPattern =
    /<span[^>]*class=["'][^"']*\btext-block-base-link\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
  const metaPattern =
    /<div[^>]*class=["'][^"']*\bmt-1\b[^"']*\btext-md\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

  let itemMatch = itemPattern.exec(source);
  while (itemMatch) {
    const itemHtml = String(itemMatch[1] || "");
    const hrefMatch = itemHtml.match(hrefPattern);
    const href = String(hrefMatch?.[1] || "").trim();
    const jobUrl = href ? new URL(href, `${config.baseOrigin || ""}/`).toString() : "";
    if (!jobUrl || seenUrls.has(jobUrl)) {
      itemMatch = itemPattern.exec(source);
      continue;
    }

    const titleFromAttr = cleanTeamtailorText(itemHtml.match(titleAttrPattern)?.[1] || "");
    const titleFromBody = cleanTeamtailorText(itemHtml.match(titleBodyPattern)?.[1] || "");
    const title = titleFromAttr || titleFromBody || "Untitled Position";

    const metaRaw = String(itemHtml.match(metaPattern)?.[1] || "");
    const metaParts = extractTeamtailorMetaParts(metaRaw);
    const department = metaParts.length > 1 ? metaParts[0] : null;
    const location = metaParts.length > 1 ? metaParts.slice(1).join(" / ") : metaParts[0] || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: jobUrl,
      posting_date: null,
      location,
      department
    });
    seenUrls.add(jobUrl);
    itemMatch = itemPattern.exec(source);
  }

  return postings;
}

async function fetchTeamtailorJobsPage(config) {
  const res = await fetchWithAtsRateLimit("teamtailor", TEAMTAILOR_RATE_LIMIT_WAIT_MS, config.jobsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teamtailor page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.jobsUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".teamtailor.com")) {
    throw new Error(`Teamtailor URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForTeamtailorCompany, parseTeamtailorCompany };