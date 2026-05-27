const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const BREEZY_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForBreezyCompany(company) {
  const config = parseBreezyCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml, finalUrl } = await fetchBreezyPortalPage(config.portalUrl);
  const parseConfig = {
    ...config,
    origin: `${parseUrl(finalUrl)?.protocol || "https:"}//${parseUrl(finalUrl)?.host || config.host}`
  };
  return parseBreezyPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}


function parseBreezyCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host === "breezy.hr" || host === "www.breezy.hr") return null;
  if (!host.endsWith(".breezy.hr")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    origin: `${parsed.protocol}//${parsed.host}`,
    portalUrl: `${parsed.protocol}//${parsed.host}/`
  };
}


function cleanBreezyText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function parseBreezyPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const linkPattern =
    /<a[^>]*href=["']((?:https?:\/\/[^"'<>]+)?\/p\/[^"'<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<h2[^>]*>([\s\S]*?)<\/h2>/i;
  const locationPattern =
    /<li[^>]*class=["'][^"']*\blocation\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i;
  const postedPattern =
    /<li[^>]*class=["'][^"']*(?:posted|created|date)[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i;
  const departmentPattern =
    /<h2[^>]*class=["'][^"']*\bgroup-header\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi;

  let linkMatch = linkPattern.exec(source);
  while (linkMatch) {
    const href = String(linkMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.origin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      linkMatch = linkPattern.exec(source);
      continue;
    }

    const linkBody = String(linkMatch[2] || "");
    const titleMatch = linkBody.match(titlePattern);
    const title = cleanBreezyText(titleMatch?.[1] || "");
    if (!title) {
      linkMatch = linkPattern.exec(source);
      continue;
    }

    const locationMatch = linkBody.match(locationPattern);
    const postedMatch = linkBody.match(postedPattern);
    const contextBefore = source.slice(Math.max(0, Number(linkMatch.index || 0) - 3000), Number(linkMatch.index || 0));
    const departmentMatches = Array.from(contextBefore.matchAll(departmentPattern));
    const department =
      departmentMatches.length > 0
        ? cleanBreezyText(departmentMatches[departmentMatches.length - 1][1] || "")
        : "";

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: cleanBreezyText(postedMatch?.[1] || "") || null,
      location: cleanBreezyText(locationMatch?.[1] || "") || null,
      department: department || null
    });
    seenUrls.add(absoluteUrl);
    linkMatch = linkPattern.exec(source);
  }

  return postings;
}


async function fetchBreezyPortalPage(urlString) {
  const res = await fetchWithAtsRateLimit("breezy", BREEZY_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Breezy page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost === "breezy.hr" || finalHost === "www.breezy.hr") {
    throw new Error(`Breezy URL redirected to main page: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForBreezyCompany, parseBreezyCompany };
