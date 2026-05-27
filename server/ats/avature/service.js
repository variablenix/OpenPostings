const { parseUrl, cleanHtmlText, urljoin, normalizeLikeText } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const AVATURE_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseAvatureCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  const pathLower = String(parsed.pathname || "").toLowerCase();
  const localeMatch = String(parsed.pathname || "").match(/^\/([a-z]{2}_[a-z]{2})(?:\/|$)/i);
  const localePrefix = localeMatch ? `/${localeMatch[1]}` : "";
  const boardUrl =
    pathLower.includes("/careers/searchjobs") || pathLower === "/careers"
      ? `${baseOrigin}${localePrefix}/careers/SearchJobs`
      : `${baseOrigin}${localePrefix}/careers/SearchJobs`;
  return { host, boardUrl, baseOrigin };
}

function extractAvatureLocationFromSubtitle(subtitleHtml, companyNameForPostings = "") {
  const subtitle = String(subtitleHtml || "");
  if (!subtitle) return null;
  const companyStem = normalizeLikeText(companyNameForPostings).replace(/[^a-z0-9]/g, "");
  const employmentLabels = new Set([
    "permanent",
    "temporary",
    "contract",
    "fixed term",
    "full time",
    "part time",
    "internship",
    "apprenticeship"
  ]);

  const locationParts = [];
  const subtitleSpanMatches = subtitle.matchAll(/<span[^>]*>(?<value>[\s\S]*?)<\/span>/gi);
  for (const subtitleSpanMatch of subtitleSpanMatches) {
    const rawValue = String(subtitleSpanMatch?.groups?.value || "").replace(/&nbsp;/gi, " ");
    const value = cleanHtmlText(rawValue).replace(/\s*(?:\u2022|\u00e2\u20ac\u00a2)\s*/g, " ").trim();
    if (!value) continue;
    const normalized = normalizeLikeText(value);
    if (!normalized) continue;
    if (/^[^a-z0-9]+$/i.test(value)) continue;
    if (normalized.startsWith("ref #") || normalized.startsWith("posted ") || normalized.startsWith("apply by ")) break;
    if (employmentLabels.has(normalized)) continue;
    if (companyStem.length >= 4) {
      const tokenStem = normalized.replace(/[^a-z0-9]/g, "");
      if (tokenStem.includes(companyStem)) continue;
    }
    locationParts.push(value);
  }

  if (locationParts.length === 0) return null;
  return locationParts.join(", ");
}

function parseAvaturePostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const articlePattern = /<article[^>]*class=['"][^'"]*\barticle--result\b[^'"]*['"][^>]*>(?<body>[\s\S]*?)<\/article>/gi;
  const titleLinkPattern = /<h3[^>]*>\s*<a[^>]+href=["'](?<href>[^"']*\/careers\/JobDetail\/[^"']+)["'][^>]*>(?<label>[\s\S]*?)<\/a>/i;
  const subtitlePattern = /<div[^>]*class=["'][^"']*\barticle__header__text__subtitle\b[^"']*["'][^>]*>(?<subtitle>[\s\S]*?)<\/div>/i;
  const linkPattern = /<a[^>]+href=["'](?<href>[^"']*\/careers\/JobDetail\/[^"']+)["'][^>]*>(?<label>.*?)<\/a>/gis;
  const idPattern = /\/JobDetail\/[^/]+\/(?<id>\d+)(?:\?|$)/i;
  let articleMatch = articlePattern.exec(source);

  while (articleMatch) {
    const articleHtml = String(articleMatch.groups?.body || "");
    const linkMatch = titleLinkPattern.exec(articleHtml);
    if (!linkMatch) {
      articleMatch = articlePattern.exec(source);
      continue;
    }

    const href = cleanHtmlText(linkMatch.groups?.href || "");
    const jobPostingUrl = urljoin(pageUrl, href);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) {
      articleMatch = articlePattern.exec(source);
      continue;
    }

    const positionName = cleanHtmlText(linkMatch.groups?.label || "");
    const normalizedTitle = normalizeLikeText(positionName);
    if (!positionName || normalizedTitle === "apply" || normalizedTitle === "read more") {
      articleMatch = articlePattern.exec(source);
      continue;
    }

    const subtitleHtml = String(subtitlePattern.exec(articleHtml)?.groups?.subtitle || "");
    const location = extractAvatureLocationFromSubtitle(subtitleHtml, companyNameForPostings);

    const idMatch = idPattern.exec(jobPostingUrl);
    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: null,
      location,
      ats_job_id: idMatch?.groups?.id || null
    });
    seenUrls.add(jobPostingUrl);
    articleMatch = articlePattern.exec(source);
  }

  if (postings.length > 0) return postings;

  let match = linkPattern.exec(source);

  while (match) {
    const href = cleanHtmlText(match.groups?.href || "");
    const jobPostingUrl = urljoin(pageUrl, href);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) {
      match = linkPattern.exec(source);
      continue;
    }

    const positionName = cleanHtmlText(match.groups?.label || "");
    const normalizedTitle = normalizeLikeText(positionName);
    if (!positionName || normalizedTitle === "apply" || normalizedTitle === "read more") {
      match = linkPattern.exec(source);
      continue;
    }

    const idMatch = idPattern.exec(jobPostingUrl);
    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: null,
      location: null,
      ats_job_id: idMatch?.groups?.id || null
    });
    seenUrls.add(jobPostingUrl);
    match = linkPattern.exec(source);
  }

  return postings;
}

function parseAvatureSeededCompanySource(urlString) {
  const parsed = parseUrl(urlString);
  const pathLower = String(parsed?.pathname || "").toLowerCase();
  if (!pathLower.includes("/careers/searchjobs") && !pathLower.includes("/careers/jobdetail/")) return null;
  return parseAvatureCompany(urlString);
}

async function collectPostingsForAvatureCompany(company) {
  const config = parseAvatureCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "avature";
  const response = await fetchWithAtsRateLimit("avature", AVATURE_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`Avature request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const pageHtml = await response.text();
  const finalUrl = String(response.url || config.boardUrl);
  return parseAvaturePostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
}

module.exports = { collectPostingsForAvatureCompany, parseAvatureSeededCompanySource };
