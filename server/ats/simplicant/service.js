const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SIMPLICANT_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForSimplicantCompany(company) {
  const config = parseSimplicantCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml, finalUrl } = await fetchSimplicantJobsPage(config);
  if (/page you were looking for could not be found/i.test(pageHtml)) return [];

  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    jobsUrl: finalUrl || config.jobsUrl
  };
  return parseSimplicantPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}


function parseSimplicantCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".simplicant.com")) return null;
  if (
    host === "simplicant.com" ||
    host === "www.simplicant.com" ||
    host === "assets.simplicant.com" ||
    host === "app.simplicant.com" ||
    host === "jobs.simplicant.com"
  ) {
    return null;
  }

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length > 0 && !["jobs", "leads"].includes(String(pathParts[0] || "").toLowerCase())) return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin,
    jobsUrl: `${baseOrigin}/`
  };
}


function cleanSimplicantText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseSimplicantPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const cardPattern =
    /<a[^>]*class=["'][^"']*\blist-group-item\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<h3[^>]*class=["'][^"']*\bjob-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i;
  const locationPattern = /<div[^>]*class=["'][^"']*\bjob-subtitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

  let match = cardPattern.exec(source);
  while (match) {
    const href = cleanSimplicantText(match[1] || "");
    if (!href || !href.includes("/jobs/") || !href.replace(/\/+$/, "").toLowerCase().endsWith("/detail")) {
      match = cardPattern.exec(source);
      continue;
    }

    const absoluteUrl = new URL(href, `${config.baseOrigin || ""}/`).toString();
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      match = cardPattern.exec(source);
      continue;
    }

    const bodyHtml = String(match[2] || "");
    const title = cleanSimplicantText(bodyHtml.match(titlePattern)?.[1] || "") || "Untitled Position";
    const location = cleanSimplicantText(bodyHtml.match(locationPattern)?.[1] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null
    });

    seenUrls.add(absoluteUrl);
    match = cardPattern.exec(source);
  }

  return postings;
}

async function fetchSimplicantJobsPage(config) {
  const res = await fetchWithAtsRateLimit("simplicant", SIMPLICANT_RATE_LIMIT_WAIT_MS, config.jobsUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Simplicant page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.jobsUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (
    !finalHost.endsWith(".simplicant.com") ||
    ["simplicant.com", "www.simplicant.com", "assets.simplicant.com", "app.simplicant.com", "jobs.simplicant.com"].includes(
      finalHost
    )
  ) {
    throw new Error(`Simplicant URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForSimplicantCompany, parseSimplicantCompany };