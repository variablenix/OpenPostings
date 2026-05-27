const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PAYLOCITY_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForPaylocityCompany(company) {
  const config = parsePaylocityCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const { pageHtml, finalUrl } = await fetchPaylocityBoardPage(config);
  const runtimeConfig = parsePaylocityCompany(finalUrl) || config;
  const companyNameForPostings = normalizedCompanyName || `paylocity_${String(runtimeConfig.companyId || "").toLowerCase()}`;
  const pageData = extractPaylocityPageDataJson(pageHtml);
  const rawPostings = parsePaylocityPostingsFromPageData(companyNameForPostings, runtimeConfig, pageData);
  const collected = [];
  const seenUrls = new Set();

  for (const posting of rawPostings) {
    const postingUrl = String(posting?.job_posting_url || "").trim();
    if (!postingUrl || seenUrls.has(postingUrl)) continue;
    if (!String(posting?.posting_date || "").trim()) continue;
    seenUrls.add(postingUrl);
    collected.push(posting);
  }

  return collected;
}




function parsePaylocityCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "recruiting.paylocity.com" && host !== "www.recruiting.paylocity.com") return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  if (pathParts.length < 5) return null;
  if (pathParts[0].toLowerCase() !== "recruiting" || pathParts[1].toLowerCase() !== "jobs") return null;

  const listingSegment = String(pathParts[2] || "All")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "") || "All";
  const companyId = String(pathParts[3] || "")
    .trim()
    .replace(/[^A-Za-z0-9-]/g, "");
  const companySlug = String(pathParts[4] || "")
    .trim()
    .replace(/[^A-Za-z0-9-_.]/g, "");
  if (!companyId || !companySlug) return null;

  const siteBaseUrl = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    siteBaseUrl,
    companyId,
    companySlug,
    boardUrl:
      `${siteBaseUrl}/recruiting/jobs/${encodeURIComponent(listingSegment)}` +
      `/${encodeURIComponent(companyId)}/${encodeURIComponent(companySlug)}`
  };
}

function cleanPaylocityText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractPaylocityPageDataJson(pageHtml) {
  const source = String(pageHtml || "");
  const marker = "window.pageData =";
  let startIndex = source.indexOf(marker);
  if (startIndex < 0) return {};

  startIndex = source.indexOf("{", startIndex);
  if (startIndex < 0) return {};

  let depth = 0;
  let inString = false;
  let escape = false;
  let stringChar = "";

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(startIndex, index + 1));
        } catch {
          return {};
        }
      }
    }
  }

  return {};
}

function parsePaylocityPostingsFromPageData(companyNameForPostings, config, pageData) {
  const jobs = Array.isArray(pageData?.Jobs) ? pageData.Jobs : [];
  const postings = [];
  const seenIds = new Set();
  const effectiveCompanyName =
    cleanPaylocityText(companyNameForPostings) || `paylocity_${String(config?.companyId || "").toLowerCase()}`;

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;

    const jobId = cleanPaylocityText(job?.JobId || "");
    const normalizedJobId = jobId.toLowerCase();
    if (!jobId || seenIds.has(normalizedJobId)) continue;

    const jobLocation = job?.JobLocation && typeof job.JobLocation === "object" ? job.JobLocation : {};
    const city = cleanPaylocityText(jobLocation?.City || "");
    const state = cleanPaylocityText(jobLocation?.State || "");
    const country = cleanPaylocityText(jobLocation?.Country || "");
    const isRemote = Boolean(job?.IsRemote);

    const locationParts = [city, state].filter(Boolean);
    let location = locationParts.join(", ");
    if (!location) location = cleanPaylocityText(job?.LocationName || "");
    if (!location && isRemote) location = "Remote";
    if (!location && country) location = country;

    postings.push({
      company_name: effectiveCompanyName,
      position_name: cleanPaylocityText(job?.JobTitle || "") || "Untitled Position",
      job_posting_url: `${String(config?.siteBaseUrl || "").replace(/\/+$/, "")}/Recruiting/Jobs/Details/${encodeURIComponent(jobId)}`,
      posting_date: cleanPaylocityText(job?.PublishedDate || "") || null,
      location: location || null,
      department: cleanPaylocityText(job?.HiringDepartment || "") || null,
      employment_type: isRemote ? "Remote" : null
    });
    seenIds.add(normalizedJobId);
  }

  return postings;
}

async function fetchPaylocityBoardPage(config) {
  const res = await fetchWithAtsRateLimit("paylocity", PAYLOCITY_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`Paylocity board request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "recruiting.paylocity.com" && finalHost !== "www.recruiting.paylocity.com") {
    throw new Error(`Paylocity URL redirected to unexpected host: ${finalUrl}`);
  }

  return {
    pageHtml: await res.text(),
    finalUrl
  };
}

module.exports = { collectPostingsForPaylocityCompany, parsePaylocityCompany };