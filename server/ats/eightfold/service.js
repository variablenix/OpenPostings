const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const EIGHTFOLD_RATE_LIMIT_WAIT_MS = 60 * 1000;


async function collectPostingsForEightfoldCompany(company) {
  const config = parseEightfoldCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const { pageHtml, finalUrl } = await fetchEightfoldCareersPage(config);
  const runtimeConfig = parseEightfoldCompany(finalUrl) || config;
  const domainValue = extractEightfoldDomainFromHtml(pageHtml);
  if (!domainValue) {
    throw new Error("Eightfold window._EF_GROUP_ID value not found in careers page");
  }

  const { responseJson } = await fetchEightfoldJobsApi(runtimeConfig, domainValue);
  const fallbackCompanyName = `eightfold_${String(runtimeConfig.host || "").split(".")[0] || "board"}`;
  const companyNameForPostings = normalizedCompanyName || fallbackCompanyName;
  const rawPostings = parseEightfoldPostingsFromApi(companyNameForPostings, runtimeConfig, responseJson);
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

function parseEightfoldCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!(host.endsWith(".eightfold.ai") || host === "eightfold.ai" || host === "www.eightfold.ai")) return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0 || pathParts[0].toLowerCase() !== "careers") return null;

  const siteBaseUrl = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    siteBaseUrl,
    boardUrl: `${siteBaseUrl}/careers`
  };
}


function cleanEightfoldText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEightfoldPostingDate(value) {
  const raw = cleanEightfoldText(value || "");
  if (!raw) return null;

  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const epochMs = numeric >= 1e12 ? numeric : numeric * 1000;
      const asDate = new Date(epochMs);
      if (!Number.isNaN(asDate.getTime())) {
        return asDate.toISOString();
      }
    }
  }

  const parsedMs = Date.parse(raw);
  if (Number.isFinite(parsedMs)) {
    return new Date(parsedMs).toISOString();
  }

  return raw;
}

function extractEightfoldDomainFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const match = source.match(/window\._EF_GROUP_ID\s*=\s*["']([^"']+)["']/i);
  const value = cleanEightfoldText(match?.[1] || "");
  return value || "";
}

function buildEightfoldApiUrl(config, domainValue) {
  const siteBaseUrl = String(config?.siteBaseUrl || "").replace(/\/+$/, "");
  const domain = cleanEightfoldText(domainValue || "");
  if (!siteBaseUrl || !domain) return "";
  return `${siteBaseUrl}/api/pcsx/search?domain=${encodeURIComponent(domain)}&query=&location=&start=0&`;
}

function parseEightfoldPostingsFromApi(companyNameForPostings, config, responseJson) {
  const data = responseJson?.data && typeof responseJson.data === "object" ? responseJson.data : {};
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  const postings = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  const fallbackCompanyKey =
    String(config?.host || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "board";
  const effectiveCompanyName = cleanEightfoldText(companyNameForPostings) || `eightfold_${fallbackCompanyKey}`;

  for (const position of positions) {
    if (!position || typeof position !== "object") continue;

    const positionId = cleanEightfoldText(position?.id || "");
    const normalizedPositionId = positionId.toLowerCase();
    if (!positionId || seenIds.has(normalizedPositionId)) continue;

    const rawPositionUrl = cleanEightfoldText(position?.positionUrl || "");
    let postingUrl = "";
    if (rawPositionUrl) {
      try {
        postingUrl = new URL(rawPositionUrl, `${String(config?.siteBaseUrl || "").replace(/\/+$/, "")}/`).toString();
      } catch {
        postingUrl = "";
      }
    }
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const locations = Array.isArray(position?.locations)
      ? position.locations.map((item) => cleanEightfoldText(item || "")).filter(Boolean)
      : [];
    const fallbackLocation = cleanEightfoldText(position?.locations || "");
    const workLocationOption = cleanEightfoldText(position?.workLocationOption || "");
    let location = locations.length > 0 ? locations.join(", ") : fallbackLocation;
    if (!location && /remote/i.test(workLocationOption)) {
      location = "Remote";
    }

    const rawPostedTs = position?.postedTs;
    const postingDate = normalizeEightfoldPostingDate(rawPostedTs);

    const department = Array.isArray(position?.department)
      ? position.department.map((item) => cleanEightfoldText(item || "")).filter(Boolean).join(" / ")
      : cleanEightfoldText(position?.department || "");
    const externalId = cleanEightfoldText(position?.atsJobId || "");

    postings.push({
      company_name: effectiveCompanyName,
      position_name: cleanEightfoldText(position?.name || "") || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: postingDate || null,
      location: location || null,
      department: department || null,
      employment_type: workLocationOption || null,
      external_id: externalId || null
    });
    seenIds.add(normalizedPositionId);
    seenUrls.add(postingUrl);
  }

  return postings;
}


async function fetchEightfoldCareersPage(config) {
  const res = await fetchWithAtsRateLimit("eightfold", EIGHTFOLD_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`Eightfold careers page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!(finalHost.endsWith(".eightfold.ai") || finalHost === "eightfold.ai" || finalHost === "www.eightfold.ai")) {
    throw new Error(`Eightfold URL redirected to unexpected host: ${finalUrl}`);
  }

  return {
    pageHtml: await res.text(),
    finalUrl
  };
}

async function fetchEightfoldJobsApi(config, domainValue) {
  const apiUrl = buildEightfoldApiUrl(config, domainValue);
  if (!apiUrl) {
    throw new Error("Eightfold API URL could not be built from careers page metadata");
  }

  const res = await fetchWithAtsRateLimit("eightfold", EIGHTFOLD_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Eightfold jobs API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || apiUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!(finalHost.endsWith(".eightfold.ai") || finalHost === "eightfold.ai" || finalHost === "www.eightfold.ai")) {
    throw new Error(`Eightfold API URL redirected to unexpected host: ${finalUrl}`);
  }

  const bodyText = await res.text();
  let responseJson = {};
  try {
    responseJson = JSON.parse(bodyText);
  } catch {
    throw new Error(`Eightfold jobs API response was not JSON: ${bodyText.slice(0, 180)}`);
  }

  return {
    responseJson,
    finalUrl
  };
}

module.exports = { collectPostingsForEightfoldCompany, parseEightfoldCompany };