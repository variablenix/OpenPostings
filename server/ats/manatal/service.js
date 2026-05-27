const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const MANATAL_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

async function collectPostingsForManatalCompany(company) {
  const config = parseManatalCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.domainSlugLower;

  const landing = await fetchManatalCareersPage(config.careersUrl || company.url_string);
  const pageHtml = String(landing?.pageHtml || "");
  const runtimeConfig = extractManatalPageRuntimeConfig(pageHtml, config, landing?.finalUrl || config.careersUrl);

  const collected = [];
  const seenUrls = new Set();

  for (let page = 1; page <= MAX_PAGES_PER_COMPANY; page += 1) {
    let responseJson = {};
    try {
      responseJson = await fetchManatalJobsApiPage(runtimeConfig, page, 50);
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 404) {
        break;
      }
      if (page > 1) break;
      throw error;
    }

    const batch = parseManatalPostingsFromApi(companyNameForPostings, runtimeConfig, responseJson);
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    const results = Array.isArray(responseJson?.results) ? responseJson.results : [];
    const totalCount = Number(responseJson?.count);
    const nextUrl = String(responseJson?.next || "").trim();
    if (results.length === 0) break;
    if (!nextUrl) break;
    if (Number.isFinite(totalCount) && totalCount >= 0 && collected.length >= totalCount) break;
  }

  if (collected.length > 0) return collected;

  if (pageHtml) {
    const fallbackPostings = parseManatalPostingsFromHtml(companyNameForPostings, runtimeConfig, pageHtml);
    for (const posting of fallbackPostings) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }
  }

  return collected;
}


function parseManatalCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "www.careers-page.com" && !host.endsWith(".careers-page.com")) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const hostSubdomain =
    host.endsWith(".careers-page.com") && host !== "www.careers-page.com"
      ? String(host.split(".")[0] || "").trim()
      : "";

  let domainSlug = hostSubdomain || String(pathParts[0] || "").trim();
  if (!domainSlug) return null;
  domainSlug = domainSlug.toLowerCase();
  if (!domainSlug || domainSlug === "job" || domainSlug === "jobs") return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  const publicBaseUrl = "https://www.careers-page.com";
  const boardUrl =
    host === "www.careers-page.com" ? `${baseOrigin}/${domainSlug}/` : `${baseOrigin}/`;

  return {
    host,
    domainSlug,
    domainSlugLower: domainSlug.toLowerCase(),
    baseOrigin,
    publicBaseUrl,
    boardUrl,
    careersUrl: boardUrl,
    jobsApiUrl: `${publicBaseUrl}/api/v1.0/c/${encodeURIComponent(domainSlug)}/jobs/`
  };
}


function cleanManatalText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractManatalPageRuntimeConfig(pageHtml, fallbackConfig, finalUrl = "") {
  const source = String(pageHtml || "");
  const fallback = fallbackConfig && typeof fallbackConfig === "object" ? fallbackConfig : {};

  const baseUrlRaw = String(source.match(/const\s+baseUrl\s*=\s*['"]([^'"]+)['"]/i)?.[1] || "").trim();
  const publicBaseUrl = (baseUrlRaw || String(fallback.publicBaseUrl || "https://www.careers-page.com")).replace(
    /\/+$/,
    ""
  );

  const slugCandidates = [];
  const candidatePatterns = [
    /const\s+clientSlug\s*=\s*['"]([^'"]+)['"]/i,
    /data-domain_slug\s*=\s*['"]([^'"]+)['"]/i,
    /<a[^>]*class=['"][^'"]*\bnavbar-brand\b[^'"]*['"][^>]*href=['"]\/([^\/"'?#]+)/i,
    /<meta[^>]*property=['"]og:type['"][^>]*content=['"]\s*([^|'"]+?)\s*\|/i
  ];
  for (const pattern of candidatePatterns) {
    const value = String(source.match(pattern)?.[1] || "").trim();
    if (value) slugCandidates.push(value);
  }

  const finalParsed = parseUrl(finalUrl) || parseUrl(String(fallback.careersUrl || fallback.boardUrl || ""));
  const finalHost = String(finalParsed?.hostname || fallback.host || "").toLowerCase();
  if (finalHost.endsWith(".careers-page.com") && finalHost !== "www.careers-page.com") {
    const hostSubdomain = String(finalHost.split(".")[0] || "").trim();
    if (hostSubdomain) slugCandidates.push(hostSubdomain);
  }

  if (fallback.domainSlug) slugCandidates.push(String(fallback.domainSlug));

  let domainSlug = "";
  for (const candidate of slugCandidates) {
    const normalized = String(candidate || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]/gi, "");
    if (!normalized || normalized === "job" || normalized === "jobs" || normalized === "www") continue;
    domainSlug = normalized;
    break;
  }

  const protocol = String(finalParsed?.protocol || "https:");
  const hostWithPort = String(finalParsed?.host || fallback.host || "www.careers-page.com");
  const boardUrl =
    finalHost === "www.careers-page.com"
      ? `${protocol}//${hostWithPort}/${domainSlug || String(fallback.domainSlug || "").toLowerCase()}/`
      : finalHost.endsWith(".careers-page.com")
        ? `${protocol}//${hostWithPort}/`
        : String(fallback.boardUrl || "");

  const resolvedSlug = domainSlug || String(fallback.domainSlug || "").toLowerCase();

  return {
    ...fallback,
    host: finalHost || String(fallback.host || "").toLowerCase(),
    domainSlug: resolvedSlug,
    domainSlugLower: resolvedSlug,
    publicBaseUrl: publicBaseUrl || "https://www.careers-page.com",
    boardUrl: boardUrl || String(fallback.boardUrl || ""),
    careersUrl: boardUrl || String(fallback.careersUrl || ""),
    jobsApiUrl: resolvedSlug
      ? `${publicBaseUrl || "https://www.careers-page.com"}/api/v1.0/c/${encodeURIComponent(resolvedSlug)}/jobs/`
      : String(fallback.jobsApiUrl || "")
  };
}


function buildManatalJobPostingUrl(config, item) {
  const posting = item && typeof item === "object" ? item : {};

  for (const key of ["url", "job_url", "apply_url", "public_url"]) {
    const raw = String(posting?.[key] || "").trim();
    if (!raw) continue;
    try {
      return new URL(raw, `${String(config?.boardUrl || config?.baseOrigin || "").replace(/\/+$/, "")}/`).toString();
    } catch {
      continue;
    }
  }

  const hash = String(posting?.hash || "").trim();
  const domainSlug = String(config?.domainSlug || "").trim();
  const publicBaseUrl = String(config?.publicBaseUrl || "https://www.careers-page.com").replace(/\/+$/, "");
  if (hash && domainSlug) {
    return `${publicBaseUrl}/${domainSlug}/job/${encodeURIComponent(hash)}`;
  }

  return String(config?.boardUrl || "").trim();
}

function parseManatalPostingsFromApi(companyNameForPostings, config, responseJson) {
  const results = Array.isArray(responseJson?.results) ? responseJson.results : [];
  const postings = [];
  const seenUrls = new Set();

  for (const job of results) {
    const item = job && typeof job === "object" ? job : {};
    const jobUrl = buildManatalJobPostingUrl(config, item);
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const locationDisplay = cleanManatalText(item?.location_display || "");
    const locationParts = [
      cleanManatalText(item?.city || ""),
      cleanManatalText(item?.state || ""),
      cleanManatalText(item?.country || "")
    ].filter(Boolean);
    const location = locationDisplay || locationParts.join(", ");

    let postingDate = null;
    for (const dateField of [
      "last_published_at",
      "published_at",
      "posting_date",
      "posted_date",
      "updated_at",
      "created_at"
    ]) {
      const candidate = cleanManatalText(item?.[dateField] || "");
      if (!candidate) continue;
      postingDate = candidate;
      break;
    }

    postings.push({
      company_name: companyNameForPostings,
      position_name: cleanManatalText(item?.position_name || item?.title || "") || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: location || null,
      department: cleanManatalText(item?.organization_name || "") || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

function parseManatalPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const cardPattern = /<article[^>]*class=['"][^'"]*\bjob-card\b[^'"]*['"][^>]*>([\s\S]*?)<\/article>/gi;
  let cardMatch = cardPattern.exec(source);
  while (cardMatch) {
    const cardHtml = String(cardMatch[1] || "");
    const href = String(
      cardHtml.match(/<a[^>]*class=['"][^'"]*\bjob-title-link\b[^'"]*['"][^>]*href=['"]([^'"]+)['"]/i)?.[1] || ""
    ).trim();
    const title = cleanManatalText(
      cardHtml.match(/<h[1-6][^>]*class=['"][^'"]*\bjob-title\b[^'"]*['"][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || ""
    );
    const looksLikeTemplateHref =
      /^getJobUrl\s*\(/i.test(href) ||
      href.includes("[[") ||
      href.includes("]]") ||
      href.includes("{{") ||
      href.includes("}}");
    const looksLikeTemplateTitle = title.includes("[[") || title.includes("]]");
    if (!href || !title || looksLikeTemplateHref || looksLikeTemplateTitle) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    let jobUrl = "";
    try {
      jobUrl = new URL(href, `${String(config?.boardUrl || config?.baseOrigin || "").replace(/\/+$/, "")}/`).toString();
    } catch {
      cardMatch = cardPattern.exec(source);
      continue;
    }
    if (!jobUrl || seenUrls.has(jobUrl)) {
      cardMatch = cardPattern.exec(source);
      continue;
    }

    const location = cleanManatalText(cardHtml.match(/<li[^>]*>[\s\S]*?<span>\s*([\s\S]*?)\s*<\/span>\s*<\/li>/i)?.[1] || "");
    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: null,
      location: location || null,
      department: null
    });
    seenUrls.add(jobUrl);
    cardMatch = cardPattern.exec(source);
  }

  if (postings.length > 0) return postings;

  const oldItemPattern = /<li[^>]*class=['"][^'"]*\bmedia\b[^'"]*['"][^>]*>([\s\S]*?)<\/li>/gi;
  let oldItemMatch = oldItemPattern.exec(source);
  while (oldItemMatch) {
    const itemHtml = String(oldItemMatch[1] || "");
    const href = String(itemHtml.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*>/i)?.[1] || "").trim();
    const title = cleanManatalText(
      itemHtml.match(/<h[1-6][^>]*class=['"][^'"]*\bjob-position-break\b[^'"]*['"][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || ""
    );
    const looksLikeTemplateHref =
      /^getJobUrl\s*\(/i.test(href) ||
      href.includes("[[") ||
      href.includes("]]") ||
      href.includes("{{") ||
      href.includes("}}");
    const looksLikeTemplateTitle = title.includes("[[") || title.includes("]]");
    if (!href || !title || looksLikeTemplateHref || looksLikeTemplateTitle) {
      oldItemMatch = oldItemPattern.exec(source);
      continue;
    }

    let jobUrl = "";
    try {
      jobUrl = new URL(href, `${String(config?.boardUrl || config?.baseOrigin || "").replace(/\/+$/, "")}/`).toString();
    } catch {
      oldItemMatch = oldItemPattern.exec(source);
      continue;
    }
    if (!jobUrl || seenUrls.has(jobUrl)) {
      oldItemMatch = oldItemPattern.exec(source);
      continue;
    }

    const location = cleanManatalText(itemHtml.match(/fa-map-marker-alt[^<]*<\/i>\s*([\s\S]*?)<\/span>/i)?.[1] || "");
    const department = cleanManatalText(itemHtml.match(/fa-building[^<]*<\/i>\s*([\s\S]*?)<\/span>/i)?.[1] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: null,
      location: location || null,
      department: department || null
    });
    seenUrls.add(jobUrl);
    oldItemMatch = oldItemPattern.exec(source);
  }

  return postings;
}
  

async function fetchManatalCareersPage(urlString) {
  const res = await fetchWithAtsRateLimit("manatal", MANATAL_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  const finalUrl = String(res.url || urlString || "").trim();
  const pageHtml = await res.text();
  return {
    status: Number(res.status || 0),
    finalUrl,
    pageHtml
  };
}


async function fetchManatalJobsApiPage(config, page = 1, pageSize = 50) {
  const jobsApiUrl = String(config?.jobsApiUrl || "").trim();
  if (!jobsApiUrl) {
    throw new Error("Manatal API URL is missing");
  }

  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    ordering: "-is_pinned_in_career_page,-last_published_at"
  }).toString();
  const url = `${jobsApiUrl}${jobsApiUrl.includes("?") ? "&" : "?"}${query}`;

  const res = await fetchWithAtsRateLimit("manatal", MANATAL_RATE_LIMIT_WAIT_MS, url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: String(config?.boardUrl || ""),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    const error = /** @type {Error & { status: number }} */ (
      new Error(`Manatal API request failed (${res.status}): ${body.slice(0, 180)}`)
    );
    error.status = Number(res.status || 0);
    throw error;
  }

  return res.json();
}

module.exports = { collectPostingsForManatalCompany, parseManatalCompany };
