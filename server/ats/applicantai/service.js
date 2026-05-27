const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const APPLICANTAI_RATE_LIMIT_WAIT_MS = 60 * 1000;


async function collectPostingsForApplicantAiCompany(company) {
  const config = parseApplicantAiCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.slugLower;
  const pageHtml = await fetchApplicantAiCareersPage(config.careersUrl);
  return parseApplicantAiPostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function parseApplicantAiCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "applicantai.com" && host !== "www.applicantai.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const slug = String(pathParts[0] || "").trim();
  if (!slug) return null;

  return {
    host,
    slug,
    slugLower: slug.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    careersUrl: `${parsed.protocol}//${parsed.host}/${slug}`
  };
}


function cleanApplicantAiText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isApplicantAiJobHref(href) {
  const candidate = String(href || "").trim();
  if (!candidate || candidate.startsWith("#") || candidate.toLowerCase().startsWith("mailto:")) {
    return false;
  }

  const parsed = parseUrl(candidate);
  if (parsed?.host) {
    const host = String(parsed.host || "").split(":")[0].toLowerCase();
    if (host !== "applicantai.com" && host !== "www.applicantai.com") {
      return false;
    }
  }

  const path = parsed ? String(parsed.pathname || "") : candidate;
  const pathParts = path
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length < 3) return false;

  return /^\d+$/.test(String(pathParts[pathParts.length - 1] || ""));
}

function parseApplicantAiPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const blockPattern = /<div[^>]*class=["'][^"']*\bmy-4\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  const headingLinkPattern = /<h4[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/i;
  const locationPattern = /<small[^>]*class=["'][^"']*\btext-muted\b[^"']*["'][^>]*>([\s\S]*?)<\/small>/i;

  let blockMatch = blockPattern.exec(source);
  while (blockMatch) {
    const blockHtml = String(blockMatch[1] || "");
    const headingMatch = blockHtml.match(headingLinkPattern);
    if (!headingMatch?.[1]) {
      blockMatch = blockPattern.exec(source);
      continue;
    }

    const href = String(headingMatch[1] || "").trim();
    if (!isApplicantAiJobHref(href)) {
      blockMatch = blockPattern.exec(source);
      continue;
    }

    const absoluteUrl = new URL(href, `${config.baseOrigin}/`).toString();
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      blockMatch = blockPattern.exec(source);
      continue;
    }

    const locationMatch = blockHtml.match(locationPattern);
    const title = cleanApplicantAiText(headingMatch[2] || "") || "Untitled Position";

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: cleanApplicantAiText(locationMatch?.[1] || "") || null
    });
    seenUrls.add(absoluteUrl);
    blockMatch = blockPattern.exec(source);
  }

  if (postings.length > 0) return postings;

  const fallbackPattern = /<h4[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/gi;
  let fallbackMatch = fallbackPattern.exec(source);
  while (fallbackMatch) {
    const href = String(fallbackMatch[1] || "").trim();
    if (!isApplicantAiJobHref(href)) {
      fallbackMatch = fallbackPattern.exec(source);
      continue;
    }

    const absoluteUrl = new URL(href, `${config.baseOrigin}/`).toString();
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      fallbackMatch = fallbackPattern.exec(source);
      continue;
    }

    const contextHtml = source.slice(
      Number(fallbackMatch.index || 0),
      Math.min(source.length, Number(fallbackMatch.index || 0) + 700)
    );
    const locationMatch = contextHtml.match(locationPattern);
    const title = cleanApplicantAiText(fallbackMatch[2] || "") || "Untitled Position";

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: cleanApplicantAiText(locationMatch?.[1] || "") || null
    });
    seenUrls.add(absoluteUrl);
    fallbackMatch = fallbackPattern.exec(source);
  }

  return postings;
}


async function fetchApplicantAiCareersPage(urlString) {
  const res = await fetchWithAtsRateLimit("applicantai", APPLICANTAI_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ApplicantAI page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}


module.exports = { collectPostingsForApplicantAiCompany, parseApplicantAiCompany };