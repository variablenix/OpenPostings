const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SAPHRCLOUD_RATE_LIMIT_WAIT_MS = 60 * 1000;
const SAPHRCLOUD_LOCALE_CANDIDATES = Object.freeze([
  "en_US",
  "en_GB",
  "de_DE",
  "fr_FR",
  "es_ES",
  "it_IT",
  "nl_NL",
  "pt_BR"
]);
const MAX_SAPHRCLOUD_PAGES_PER_LOCALE = 25;

async function collectPostingsForSapHrCloudCompany(company) {
  const config = parseSapHrCloudCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyNameLower;
  const { pageHtml, finalUrl } = await fetchSapHrCloudBoardPage(config.boardUrl, company.url_string);
  const htmlPostings = parseSapHrCloudPostingsFromHtml(companyNameForPostings, config, pageHtml, finalUrl);

  let apiPostings = [];
  let apiError = null;
  try {
    const localeCandidates = buildSapHrCloudLocaleCandidates(config, finalUrl, pageHtml);
    apiPostings = await collectSapHrCloudPostingsFromApi(companyNameForPostings, config, localeCandidates, finalUrl);
  } catch (error) {
    apiError = error;
  }

  const mergedPostings = mergeSapHrCloudPostings(htmlPostings, apiPostings);
  if (mergedPostings.length > 0) return mergedPostings;
  if (apiError) throw apiError;
  return mergedPostings;
}


function parseSapHrCloudCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  const suffix = ".jobs.hr.cloud.sap";
  if (!host.endsWith(suffix)) return null;

  const companyName = String(host.slice(0, -suffix.length) || "").trim();
  if (!companyName) return null;

  const localeFromUrl = String(parsed.searchParams.get("locale") || "").trim();
  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    companyName,
    companyNameLower: companyName.toLowerCase(),
    baseOrigin,
    boardUrl: `${baseOrigin}/search/?createNewAlert=false&q=`,
    apiUrl: `${baseOrigin}/services/recruiting/v1/jobs`,
    localeFromUrl: localeFromUrl || ""
  };
}


function cleanSapHrCloudText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function firstSapHrCloudTextValue(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const cleaned = cleanSapHrCloudText(entry);
      if (cleaned) return cleaned;
    }
    return "";
  }
  return cleanSapHrCloudText(value);
}

function normalizeSapHrCloudLocaleValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^([a-z]{2})[_-]([a-z]{2})$/i);
  if (match?.[1] && match?.[2]) {
    return `${match[1].toLowerCase()}_${match[2].toUpperCase()}`;
  }
  return raw;
}

function parseSapHrCloudLocaleFromUrl(urlString) {
  try {
    const parsed = new URL(String(urlString || "").trim());
    return normalizeSapHrCloudLocaleValue(parsed.searchParams.get("locale"));
  } catch {
    return "";
  }
}

function parseSapHrCloudLocaleFromHtml(pageHtml) {
  const sourceHtml = String(pageHtml || "");
  if (!sourceHtml) return "";
  const localeMatch =
    sourceHtml.match(/<html[^>]*\b(?:xml:lang|lang)=["'](?<value>[a-z]{2}(?:[_-][a-z]{2})?)["']/i) ||
    sourceHtml.match(/\blocale["']?\s*[:=]\s*["'](?<value>[a-z]{2}(?:[_-][a-z]{2})?)["']/i);
  return normalizeSapHrCloudLocaleValue(localeMatch?.groups?.value || "");
}

function buildSapHrCloudLocaleCandidates(config, finalUrl = "", pageHtml = "") {
  const seen = new Set();
  const candidates = [];
  const push = (rawLocale) => {
    const normalized = normalizeSapHrCloudLocaleValue(rawLocale);
    if (!normalized) return;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push(normalized);
  };

  push(config?.localeFromUrl);
  push(parseSapHrCloudLocaleFromUrl(finalUrl));
  push(parseSapHrCloudLocaleFromHtml(pageHtml));
  for (const locale of SAPHRCLOUD_LOCALE_CANDIDATES) {
    push(locale);
  }

  return candidates.length > 0 ? candidates : ["en_US"];
}

function buildSapHrCloudJobUrl(config, item = {}, locale = "en_US") {
  const id = cleanSapHrCloudText(item?.id || "");
  if (!id) return "";

  const slugSourceRaw =
    cleanSapHrCloudText(item?.unifiedUrlTitle || "") ||
    cleanSapHrCloudText(item?.urlTitle || "") ||
    cleanSapHrCloudText(item?.unifiedStandardTitle || "") ||
    "untitled";
  let slugSource = slugSourceRaw;
  try {
    slugSource = decodeURIComponent(slugSourceRaw);
  } catch {
    slugSource = slugSourceRaw;
  }
  const slug = encodeURIComponent(
    String(slugSource || "")
      .replace(/[\\/]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
  const localeValue = String(locale || config?.localeFromUrl || "en_US").trim() || "en_US";
  return `${config.baseOrigin}/job/${slug}/${encodeURIComponent(id)}-${encodeURIComponent(localeValue)}`;
}

function parseSapHrCloudPostingsFromApi(companyNameForPostings, config, responseJson, locale = "en_US") {
  const jobSearchResult = Array.isArray(responseJson?.jobSearchResult) ? responseJson.jobSearchResult : [];
  const postings = [];
  const seenUrls = new Set();

  for (const rawItem of jobSearchResult) {
    const item =
      rawItem && typeof rawItem === "object"
        ? rawItem.response && typeof rawItem.response === "object"
          ? rawItem.response
          : rawItem
        : {};

    const absoluteUrlRaw = String(item?.jobUrl || item?.url || item?.applyUrl || "").trim();
    let jobUrl = "";
    if (absoluteUrlRaw) {
      try {
        jobUrl = new URL(absoluteUrlRaw, `${config.baseOrigin}/`).toString();
      } catch {
        jobUrl = "";
      }
    }
    if (!jobUrl) {
      jobUrl = buildSapHrCloudJobUrl(config, item, locale);
    }
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const locationFromCoordinates = Array.isArray(item?.jobLocationShortWithCoordinates)
      ? firstSapHrCloudTextValue(item.jobLocationShortWithCoordinates.map((entry) => entry?.value))
      : "";
    const location =
      firstSapHrCloudTextValue(item?.jobLocationShort) ||
      locationFromCoordinates ||
      firstSapHrCloudTextValue(item?.jobLocationState) ||
      firstSapHrCloudTextValue(item?.jobLocationCountry) ||
      null;
    const department =
      firstSapHrCloudTextValue(item?.filter8) ||
      firstSapHrCloudTextValue(item?.filter2) ||
      firstSapHrCloudTextValue(item?.businessUnit_obj) ||
      null;
    const postingDate =
      cleanSapHrCloudText(
        item?.unifiedStandardStart || item?.postedDate || item?.publishDate || item?.startDate || ""
      ) || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name:
        cleanSapHrCloudText(item?.unifiedStandardTitle || item?.title || item?.urlTitle || "") || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location,
      department
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

function mergeSapHrCloudPostings(htmlPostings = [], apiPostings = []) {
  const byUrl = new Map();
  const allPostings = [...(Array.isArray(htmlPostings) ? htmlPostings : []), ...(Array.isArray(apiPostings) ? apiPostings : [])];

  const scorePosting = (posting) => {
    let score = 0;
    if (String(posting?.position_name || "").trim()) score += 1;
    if (String(posting?.posting_date || "").trim()) score += 1;
    if (String(posting?.location || "").trim()) score += 1;
    if (String(posting?.department || "").trim()) score += 1;
    return score;
  };

  for (const posting of allPostings) {
    const key = String(posting?.job_posting_url || "").trim();
    if (!key) continue;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, posting);
      continue;
    }

    const existingScore = scorePosting(existing);
    const nextScore = scorePosting(posting);
    byUrl.set(key, nextScore >= existingScore ? { ...existing, ...posting } : { ...posting, ...existing });
  }

  return Array.from(byUrl.values());
}

function parseSapHrCloudPostingsFromHtml(companyNameForPostings, config, pageHtml, finalUrl = "") {
  const sourceHtml = String(pageHtml || "");
  if (!sourceHtml) return [];

  const postings = [];
  const seenUrls = new Set();
  const baseForUrls = String(finalUrl || config?.baseOrigin || "").trim() || String(config?.baseOrigin || "").trim();
  if (!baseForUrls) return [];

  const titleLinkPattern = /<a[^>]*class="[^"]*\bjobTitle-link\b[^"]*"[^>]*href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/gi;

  for (const match of sourceHtml.matchAll(titleLinkPattern)) {
    const href = cleanSapHrCloudText(match?.groups?.href || "");
    const title = cleanSapHrCloudText(match?.groups?.title || "") || "Untitled Position";
    if (!href) continue;

    let jobUrl = "";
    try {
      jobUrl = new URL(href, baseForUrls).toString();
    } catch {
      jobUrl = "";
    }
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const startIndex = Math.max(0, Number(match.index || 0) - 600);
    const endIndex = Math.min(sourceHtml.length, Number(match.index || 0) + String(match[0] || "").length + 1500);
    const context = sourceHtml.slice(startIndex, endIndex);

    const locationMatch =
      context.match(
        /<(?:span|div)[^>]*class="[^"]*\bjobLocation\b[^"]*"[^>]*>(?<value>[\s\S]*?)<\/(?:span|div)>/i
      ) ||
      context.match(/<div[^>]*id="job-\d+-desktop-section-city-value"[^>]*>(?<value>[\s\S]*?)<\/div>/i);
    const dateMatch = context.match(/<span[^>]*class="[^"]*\bjobDate\b[^"]*"[^>]*>(?<value>[\s\S]*?)<\/span>/i);
    const departmentMatch = context.match(
      /<span[^>]*class="[^"]*\bjobDepartment\b[^"]*"[^>]*>(?<value>[\s\S]*?)<\/span>/i
    );

    const location = cleanSapHrCloudText(locationMatch?.groups?.value || "") || null;
    const postingDate = cleanSapHrCloudText(dateMatch?.groups?.value || "") || null;
    const department = cleanSapHrCloudText(departmentMatch?.groups?.value || "") || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location,
      department
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}


function buildSapHrCloudSearchPayload(locale = "en_US", pageNumber = 0) {
  const normalizedPage = Math.max(0, Math.floor(Number(pageNumber || 0)));
  return {
    locale: String(locale || "en_US"),
    pageNumber: normalizedPage,
    sortBy: "",
    keywords: "",
    location: "",
    facetFilters: {},
    brand: "",
    skills: [],
    categoryId: 0,
    alertId: "",
    rcmCandidateId: ""
  };
}

async function fetchSapHrCloudJobsPage(config, locale = "en_US", pageNumber = 0, refererUrl = "") {
  const payload = buildSapHrCloudSearchPayload(locale, pageNumber);
  const normalizedReferer = String(refererUrl || config?.boardUrl || "").trim() || String(config?.baseOrigin || "").trim();
  const res = await fetchWithAtsRateLimit("saphrcloud", SAPHRCLOUD_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: config.baseOrigin,
      Referer: normalizedReferer
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SAP HR Cloud API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

async function collectSapHrCloudPostingsFromApi(companyNameForPostings, config, localeCandidates = [], finalUrl = "") {
  const locales = Array.isArray(localeCandidates) && localeCandidates.length > 0 ? localeCandidates : ["en_US"];
  const apiRefererUrl = String(finalUrl || config?.boardUrl || "").trim() || config.boardUrl;
  for (const locale of locales) {
    const collected = [];
    const seenUrls = new Set();
    for (let pageNumber = 0; pageNumber < MAX_SAPHRCLOUD_PAGES_PER_LOCALE; pageNumber += 1) {
      const responseJson = await fetchSapHrCloudJobsPage(config, locale, pageNumber, apiRefererUrl);
      const batch = parseSapHrCloudPostingsFromApi(companyNameForPostings, config, responseJson, locale);
      if (batch.length === 0) break;

      let appendedCount = 0;
      for (const posting of batch) {
        const key = String(posting?.job_posting_url || "").trim();
        if (!key || seenUrls.has(key)) continue;
        seenUrls.add(key);
        collected.push(posting);
        appendedCount += 1;
      }

      if (appendedCount === 0) break;
      if (batch.length < 10) break;
    }

    if (collected.length > 0) {
      return collected;
    }
  }

  return [];
}

async function fetchSapHrCloudBoardPage(primaryUrl, fallbackUrl = "") {
  const candidates = Array.from(
    new Set(
      [primaryUrl, fallbackUrl]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  let lastStatus = 0;
  let lastBody = "";
  let lastUrl = "";

  for (const candidateUrl of candidates) {
    const res = await fetchWithAtsRateLimit("saphrcloud", SAPHRCLOUD_RATE_LIMIT_WAIT_MS, candidateUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    });

    if (res.ok) {
      return {
        pageHtml: await res.text(),
        finalUrl: String(res.url || candidateUrl || "").trim()
      };
    }

    lastStatus = Number(res.status || 0);
    lastBody = await res.text();
    lastUrl = candidateUrl;
  }

  throw new Error(`SAP HR Cloud page request failed (${lastStatus}) for ${lastUrl}: ${String(lastBody || "").slice(0, 180)}`);
}


module.exports = { collectPostingsForSapHrCloudCompany, parseSapHrCloudCompany };
