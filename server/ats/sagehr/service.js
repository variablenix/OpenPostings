const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const { spawnSync } = require("child_process");
const SAGEHR_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForSagehrCompany(company) {
  const config = parseSagehrCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const { pageHtml, finalUrl } = await fetchSagehrJobsPage(config);
  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    boardUrl: finalUrl || config.boardUrl
  };
  const inferredCompanyName = extractSagehrCompanyNameFromHtml(pageHtml);
  const companyNameForPostings =
    normalizedCompanyName ||
    (inferredCompanyName !== "Unknown Company" ? inferredCompanyName : "") ||
    `sagehr_${config.companySlugLower}`;

  return parseSagehrPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}

function parseSagehrCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "talent.sage.hr" && host !== "www.talent.sage.hr") return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const companySlug = String(pathParts[0] || "").trim();
  if (!companySlug) return null;
  if (companySlug.toLowerCase() === "embed" || companySlug.toLowerCase() === "jobs") return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    baseOrigin,
    boardUrl: `${baseOrigin}/${encodeURIComponent(companySlug)}/vacancies`
  };
}


function cleanSagehrText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractSagehrCompanyNameFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const companyMatch = source.match(
    /<div[^>]*class=['"][^'"]*\btitle-wrap\b[^'"]*['"][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i
  );
  const fromTitleWrap = cleanSagehrText(companyMatch?.[1] || "");
  if (fromTitleWrap) return fromTitleWrap;

  const fallbackMatch = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const fallback = cleanSagehrText(fallbackMatch?.[1] || "");
  return fallback || "Unknown Company";
}

function parseSagehrPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const jobPattern =
    /<div[^>]*class=['"][^'"]*\bjob\b[^'"]*['"][^>]*>[\s\S]*?<a[^>]*class=['"][^'"]*\btitle\b[^'"]*['"][^>]*href=['"]([^"']+)['"][^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<div[^>]*class=['"][^'"]*\blocation\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>)?[\s\S]*?<\/div>/gi;

  let jobMatch = jobPattern.exec(source);
  while (jobMatch) {
    const hrefRaw = cleanSagehrText(jobMatch?.[1] || "");
    const href = decodeHtmlEntities(hrefRaw).replace(/\s+/g, "");
    if (!href || !href.toLowerCase().includes("/jobs/")) {
      jobMatch = jobPattern.exec(source);
      continue;
    }

    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(href, `${config.baseOrigin || ""}/`).toString();
    } catch {
      jobMatch = jobPattern.exec(source);
      continue;
    }

    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      jobMatch = jobPattern.exec(source);
      continue;
    }

    const title = cleanSagehrText(jobMatch?.[2] || "") || "Untitled Position";
    const location = cleanSagehrText(jobMatch?.[3] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null
    });
    seenUrls.add(absoluteUrl);
    jobMatch = jobPattern.exec(source);
  }

  return postings;
}

function hasExpectedSagehrLayout(pageHtml) {
  const loweredPageHtml = String(pageHtml || "").toLowerCase();
  return (
    loweredPageHtml.includes("title-wrap") ||
    loweredPageHtml.includes("other-jobs") ||
    loweredPageHtml.includes("<h1") ||
    loweredPageHtml.includes("/jobs/")
  );
}

function fetchSagehrPageWithCurlFallback(url, headers, timeoutSeconds = 30) {
  const userAgent = String(headers?.["User-Agent"] || "").trim();
  const accept = String(headers?.Accept || "*/*").trim();
  const acceptLanguage = String(headers?.["Accept-Language"] || "en-US,en;q=0.9").trim();
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return null;

  const curlArgs = [
    "-L",
    normalizedUrl,
    "-A",
    userAgent,
    "-H",
    `Accept: ${accept}`,
    "-H",
    `Accept-Language: ${acceptLanguage}`,
    "--max-time",
    String(Math.max(5, Number(timeoutSeconds) || 30)),
    "--silent",
    "--show-error",
    "--output",
    "-",
    "--write-out",
    "\n__CURL_STATUS__:%{http_code}\n__CURL_URL__:%{url_effective}\n"
  ];

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  const tryRunCurl = (command) => {
    const run = spawnSync(command, curlArgs, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024
    });
    stdout = String(run?.stdout || "");
    stderr = String(run?.stderr || "");
    exitCode = Number(run?.status || 0);
    return exitCode === 0;
  };

  const didRun = tryRunCurl("curl.exe") || tryRunCurl("curl");
  if (!didRun) return null;

  const markerIndex = stdout.lastIndexOf("\n__CURL_STATUS__:");
  const body = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const markerBlock = markerIndex >= 0 ? stdout.slice(markerIndex) : stdout;
  const statusMatch = markerBlock.match(/__CURL_STATUS__:(\d{3})/);
  const urlMatch = markerBlock.match(/__CURL_URL__:(\S+)/);
  const statusCode = Number(statusMatch?.[1] || 0);
  const finalUrl = String(urlMatch?.[1] || normalizedUrl).trim();

  if (!statusCode) return null;
  return {
    statusCode,
    finalUrl,
    pageHtml: String(body || ""),
    stderr
  };
}



async function fetchSagehrJobsPage(config) {
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  };

  const res = await fetchWithAtsRateLimit("sagehr", SAGEHR_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers
  });

  let statusCode = Number(res.status || 0);
  let finalUrl = String(res.url || config.boardUrl || "").trim();
  let pageHtml = await res.text();

  const shouldTryCurlFallback =
    statusCode !== 200 ||
    !String(pageHtml || "").trim() ||
    (statusCode === 403 && !hasExpectedSagehrLayout(pageHtml));

  if (shouldTryCurlFallback) {
    const fallback = fetchSagehrPageWithCurlFallback(config.boardUrl, headers, 30);
    if (fallback && (fallback.statusCode === 200 || fallback.statusCode === 403)) {
      statusCode = Number(fallback.statusCode || statusCode);
      finalUrl = String(fallback.finalUrl || finalUrl).trim();
      pageHtml = String(fallback.pageHtml || pageHtml);
    }
  }

  if (statusCode !== 200 && statusCode !== 403) {
    throw new Error(`SageHR page request failed (${statusCode})`);
  }

  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "talent.sage.hr" && finalHost !== "www.talent.sage.hr") {
    throw new Error(`SageHR URL redirected to unexpected host: ${finalUrl}`);
  }

  if (!String(pageHtml || "").trim()) {
    throw new Error(`SageHR page response was empty (${statusCode})`);
  }

  if (statusCode === 403 && !hasExpectedSagehrLayout(pageHtml)) {
    throw new Error("SageHR page request failed (403)");
  }

  return { pageHtml, finalUrl };
}

module.exports = { collectPostingsForSagehrCompany, parseSagehrCompany };
