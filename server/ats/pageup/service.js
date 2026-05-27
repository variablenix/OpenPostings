const { parseUrl, cleanHtmlText, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PAGEUP_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForPageupCompany(company) {
  const config = parsePageupCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const { pageHtml, finalUrl } = await fetchPageupBoardPage(config);
  const finalParsed = parseUrl(finalUrl);
  const baseOrigin = `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`;
  const routeConfig = extractPageupRouteConfigFromUrl(finalUrl, config.routeType, config.locale);
  const runtimeConfig = {
    ...config,
    baseOrigin,
    boardUrl: finalUrl || config.boardUrl,
    routeType: routeConfig.routeType,
    locale: routeConfig.locale,
    searchUrl: `${baseOrigin}/${encodeURIComponent(config.boardId)}/${routeConfig.routeType}/${routeConfig.locale}/search/`
  };

  const inferredCompanyName = extractPageupCompanyNameFromTitle(pageHtml);
  const companyNameForPostings =
    normalizedCompanyName ||
    (inferredCompanyName !== "Unknown Company" ? inferredCompanyName : "") ||
    `pageup_${String(config.boardId || "").toLowerCase()}`;
  const { responseJson } = await fetchPageupSearchResults(runtimeConfig);
  const resultsHtml = String(responseJson?.results || "");
  const rawPostings = parsePageupPostingsFromResults(companyNameForPostings, runtimeConfig, resultsHtml);
  const collected = [];
  const seenUrls = new Set();

  for (const posting of rawPostings) {
    const postingUrl = String(posting?.job_posting_url || "").trim();
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    let postingDate = "";
    try {
      const detailsHtml = await fetchPageupDetailsPage(postingUrl);
      postingDate = String(extractPageupPostingDateFromDetailHtml(detailsHtml) || "").trim();
    } catch {
      continue;
    }
    if (!postingDate) continue;

    collected.push({
      ...posting,
      posting_date: postingDate
    });
    seenUrls.add(postingUrl);
  }

  return collected;
}


function parsePageupCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "careers.pageuppeople.com" && host !== "www.careers.pageuppeople.com") return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const boardId = String(pathParts[0] || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "");
  if (!boardId) return null;

  let routeType = "cw";
  let locale = "en-us";
  if (pathParts.length >= 3) {
    const maybeRouteType = String(pathParts[1] || "").trim().toLowerCase();
    const maybeLocale = String(pathParts[2] || "").trim().toLowerCase();
    if (maybeRouteType === "cw" || maybeRouteType === "ci") {
      routeType = maybeRouteType;
    }
    if (/^[a-z]{2}(?:-[a-z]{2})$/i.test(maybeLocale)) {
      locale = maybeLocale;
    }
  }

  const encodedBoardId = encodeURIComponent(boardId);
  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    boardId,
    routeType,
    locale,
    baseOrigin,
    boardUrl: `${baseOrigin}/${encodedBoardId}`,
    searchUrl: `${baseOrigin}/${encodedBoardId}/${routeType}/${locale}/search/`
  };
}

function extractPageupRouteConfigFromUrl(urlString, fallbackRouteType = "cw", fallbackLocale = "en-us") {
  const parsed = parseUrl(urlString);
  const pathParts = String(parsed?.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  let routeType = String(fallbackRouteType || "cw").trim().toLowerCase() || "cw";
  let locale = String(fallbackLocale || "en-us").trim().toLowerCase() || "en-us";

  if (pathParts.length >= 3) {
    const maybeRouteType = String(pathParts[1] || "").trim().toLowerCase();
    const maybeLocale = String(pathParts[2] || "").trim().toLowerCase();
    if (maybeRouteType === "cw" || maybeRouteType === "ci") {
      routeType = maybeRouteType;
    }
    if (/^[a-z]{2}(?:-[a-z]{2})$/i.test(maybeLocale)) {
      locale = maybeLocale;
    }
  }

  return {
    routeType,
    locale
  };
}

function extractPageupCompanyNameFromTitle(pageHtml) {
  const source = String(pageHtml || "");
  const title = cleanHtmlText(source.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1] || "");
  if (!title) return "Unknown Company";
  const parts = title.split("|").map((part) => String(part || "").trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts[parts.length - 1];
  }
  return title;
}

function extractPageupPostingDateFromListingRow(rowHtml) {
  const source = String(rowHtml || "");
  const patterns = [
    /<span[^>]*class=['"][^'"]*\bposted-date\b[^'"]*['"][^>]*>[\s\S]*?<time[^>]*datetime=['"]([^'"]+)['"]/i,
    /<span[^>]*class=['"][^'"]*\bopen-date\b[^'"]*['"][^>]*>[\s\S]*?<time[^>]*datetime=['"]([^'"]+)['"]/i,
    /<span[^>]*class=['"][^'"]*\bposting-date\b[^'"]*['"][^>]*>[\s\S]*?<time[^>]*datetime=['"]([^'"]+)['"]/i
  ];
  for (const pattern of patterns) {
    const value = cleanHtmlText(source.match(pattern)?.[1] || "");
    if (value) return value;
  }
  return "";
}

function extractPageupPostingDateFromDetailHtml(pageHtml) {
  const source = String(pageHtml || "");
  const patterns = [
    /<span[^>]*class=['"][^'"]*\bopen-date\b[^'"]*['"][^>]*>\s*<time[^>]*datetime=['"]([^'"]+)['"]/i,
    /<b>\s*Advertised:\s*<\/b>\s*<span[^>]*>\s*<time[^>]*datetime=['"]([^'"]+)['"]/i,
    /<span[^>]*class=['"][^'"]*\bopen-date\b[^'"]*['"][^>]*>\s*<time[^>]*>([^<]+)<\/time>/i
  ];
  for (const pattern of patterns) {
    const value = cleanHtmlText(source.match(pattern)?.[1] || "");
    if (value) return value;
  }
  return "";
}

function extractPageupPostingId(jobPostingUrl) {
  const parsed = parseUrl(jobPostingUrl);
  if (!parsed) return "";
  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const loweredPathParts = pathParts.map((part) => part.toLowerCase());
  const jobIndex = loweredPathParts.indexOf("job");
  if (jobIndex >= 0 && pathParts[jobIndex + 1]) {
    return String(pathParts[jobIndex + 1] || "").trim();
  }
  return "";
}

function parsePageupPostingsFromResults(companyNameForPostings, config, resultsHtml) {
  const source = String(resultsHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const linkPattern =
    /<a[^>]*class=['"][^'"]*\bjob-link\b[^'"]*['"][^>]*href=['"]([^"']+)['"][^>]*>([\s\S]*?)<\/a>/i;
  const locationPattern = /<span[^>]*class=['"][^'"]*\blocation\b[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i;

  let rowMatch = rowPattern.exec(source);
  while (rowMatch) {
    const rowHtml = String(rowMatch[1] || "");
    const linkMatch = rowHtml.match(linkPattern);
    const hrefRaw = String(linkMatch?.[1] || "").trim();
    const href = decodeHtmlEntities(hrefRaw).replace(/\s+/g, "");
    if (!href) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(href, `${config.baseOrigin || ""}/`).toString();
    } catch {
      rowMatch = rowPattern.exec(source);
      continue;
    }
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const title = cleanHtmlText(linkMatch?.[2] || "") || "Untitled Position";
    const location = cleanHtmlText(rowHtml.match(locationPattern)?.[1] || "");
    const postingDate = extractPageupPostingDateFromListingRow(rowHtml);
    const postingId = extractPageupPostingId(absoluteUrl);

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: postingDate || null,
      location: location || null,
      external_id: postingId || null
    });

    seenUrls.add(absoluteUrl);
    rowMatch = rowPattern.exec(source);
  }

  return postings;
}


async function fetchPageupBoardPage(config) {
  const res = await fetchWithAtsRateLimit("pageup", PAGEUP_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PageUp board request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "careers.pageuppeople.com" && finalHost !== "www.careers.pageuppeople.com") {
    throw new Error(`PageUp URL redirected to unexpected host: ${finalUrl}`);
  }

  return {
    pageHtml: await res.text(),
    finalUrl
  };
}

async function fetchPageupSearchResults(config) {
  const res = await fetchWithAtsRateLimit("pageup", PAGEUP_RATE_LIMIT_WAIT_MS, config.searchUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: String(config?.boardUrl || ""),
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PageUp search request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.searchUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "careers.pageuppeople.com" && finalHost !== "www.careers.pageuppeople.com") {
    throw new Error(`PageUp search URL redirected to unexpected host: ${finalUrl}`);
  }

  const bodyText = await res.text();
  let responseJson = {};
  try {
    responseJson = JSON.parse(bodyText);
  } catch {
    throw new Error(`PageUp search response was not JSON: ${bodyText.slice(0, 180)}`);
  }

  return {
    responseJson,
    finalUrl
  };
}

async function fetchPageupDetailsPage(jobPostingUrl) {
  const res = await fetchWithAtsRateLimit("pageup", PAGEUP_RATE_LIMIT_WAIT_MS, jobPostingUrl, {
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PageUp details request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || jobPostingUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "careers.pageuppeople.com" && finalHost !== "www.careers.pageuppeople.com") {
    throw new Error(`PageUp details URL redirected to unexpected host: ${finalUrl}`);
  }

  return res.text();
}

module.exports = { collectPostingsForPageupCompany, parsePageupCompany };
