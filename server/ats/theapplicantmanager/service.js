const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const THEAPPLICANTMANAGER_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForTheApplicantManagerCompany(company) {
  const config = parseTheApplicantManagerCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyCodeLower;
  const pageHtml = await fetchTheApplicantManagerPage(config.careersUrl);
  return parseTheApplicantManagerPostingsFromHtml(companyNameForPostings, config, pageHtml);
}

function parseTheApplicantManagerCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "theapplicantmanager.com" && host !== "www.theapplicantmanager.com") return null;

  const companyCode = String(parsed.searchParams.get("co") || "").trim().toLowerCase();
  if (!companyCode) return null;

  return {
    host,
    companyCode,
    companyCodeLower: companyCode.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    careersUrl: `${parsed.protocol}//${parsed.host}/careers?co=${encodeURIComponent(companyCode)}`
  };
}


function cleanTheApplicantManagerText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTheApplicantManagerLocationFromTitle(title) {
  const source = String(title || "").trim();
  if (!source) return "";

  const trailingParenMatch = source.match(/\(([^()]+)\)\s*$/);
  const candidate = cleanTheApplicantManagerText(trailingParenMatch?.[1] || "");
  if (!candidate) return "";

  const hasGeoHint =
    candidate.includes(",") ||
    /\b(remote|hybrid|onsite|on-site)\b/i.test(candidate) ||
    /\b[A-Z]{2}\b/.test(candidate);
  if (!hasGeoHint) return "";

  return candidate;
}

function parseTheApplicantManagerPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  let currentDepartment = "";

  const paragraphPattern =
    /<p[^>]*class=["']([^"']*\bpos_title_list\b[^"']*)["'][^>]*>([\s\S]*?)<\/p>/gi;
  const linkPattern =
    /<a[^>]*class=["'][^"']*\bpos_title_list\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;

  let paragraphMatch = paragraphPattern.exec(source);
  while (paragraphMatch) {
    const classNames = String(paragraphMatch[1] || "").toLowerCase();
    const bodyHtml = String(paragraphMatch[2] || "");

    if (classNames.includes("bold_font")) {
      currentDepartment = cleanTheApplicantManagerText(bodyHtml);
      paragraphMatch = paragraphPattern.exec(source);
      continue;
    }

    const linkMatch = bodyHtml.match(linkPattern);
    if (!linkMatch?.[1]) {
      paragraphMatch = paragraphPattern.exec(source);
      continue;
    }

    const href = String(linkMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      paragraphMatch = paragraphPattern.exec(source);
      continue;
    }

    const title = cleanTheApplicantManagerText(linkMatch[2] || "");
    if (!title || title.toLowerCase() === "resume") {
      paragraphMatch = paragraphPattern.exec(source);
      continue;
    }
    const location = extractTheApplicantManagerLocationFromTitle(title);

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null,
      department: currentDepartment || null
    });
    seenUrls.add(absoluteUrl);
    paragraphMatch = paragraphPattern.exec(source);
  }

  if (postings.length > 0) return postings;

  const fallbackLinkPattern =
    /<a[^>]*class=["'][^"']*\bpos_title_list\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let fallbackMatch = fallbackLinkPattern.exec(source);
  while (fallbackMatch) {
    const href = String(fallbackMatch[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      fallbackMatch = fallbackLinkPattern.exec(source);
      continue;
    }

    const title = cleanTheApplicantManagerText(fallbackMatch[2] || "");
    if (!title || title.toLowerCase() === "resume") {
      fallbackMatch = fallbackLinkPattern.exec(source);
      continue;
    }
    const location = extractTheApplicantManagerLocationFromTitle(title);

    const contextBefore = source.slice(Math.max(0, Number(fallbackMatch.index || 0) - 1200), Number(fallbackMatch.index || 0));
    const departmentMatches = Array.from(
      contextBefore.matchAll(
        /<p[^>]*class=["'][^"']*\bpos_title_list\b[^"']*\bbold_font\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi
      )
    );
    const department =
      departmentMatches.length > 0 ? cleanTheApplicantManagerText(departmentMatches[departmentMatches.length - 1][1] || "") : "";

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null,
      department: department || null
    });
    seenUrls.add(absoluteUrl);
    fallbackMatch = fallbackLinkPattern.exec(source);
  }

  return postings;
}

async function fetchTheApplicantManagerPage(careersUrl) {
  const res = await fetchWithAtsRateLimit(
    "theapplicantmanager",
    THEAPPLICANTMANAGER_RATE_LIMIT_WAIT_MS,
    careersUrl,
    {
      method: "GET",
      headers: {
        Accept: "*/*"
      }
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TheApplicantManager page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}


module.exports = { collectPostingsForTheApplicantManagerCompany, parseTheApplicantManagerCompany };
