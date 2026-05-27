
const { parseUrl, decodeHtmlEntities, extractCookieHeaderFromResponse } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const BRASSRING_RATE_LIMIT_WAIT_MS = 60 * 1000;



function cleanBrassringText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBrassringHiddenInput(pageHtml, fieldName) {
  const source = String(pageHtml || "");
  const match = source.match(
    new RegExp(`name=["']${String(fieldName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*value=["']([^"']*)["']`, "i")
  );
  return cleanBrassringText(match?.[1] || "");
}

function extractBrassringCompanyName(pageHtml) {
  const source = decodeHtmlEntities(String(pageHtml || ""));
  const partnerNameMatch = source.match(/["']PartnerName["']\s*:\s*["']([^"']+)["']/i);
  if (partnerNameMatch?.[1]) return cleanBrassringText(partnerNameMatch[1]) || "Unknown Company";

  const titleMatch = source.match(/Search\s+Jobs\s+at\s*\|\s*([^<\r\n]+)/i);
  if (titleMatch?.[1]) return cleanBrassringText(titleMatch[1]) || "Unknown Company";

  return "Unknown Company";
}

function extractBrassringQuestionValue(item, questionName) {
  const questions = Array.isArray(item?.Questions) ? item.Questions : [];
  const normalizedQuestionName = String(questionName || "").trim().toLowerCase();
  for (const question of questions) {
    if (!question || typeof question !== "object") continue;
    const currentName = String(question?.QuestionName || "").trim().toLowerCase();
    if (currentName !== normalizedQuestionName) continue;
    return cleanBrassringText(question?.Value || "");
  }
  return "";
}

function extractBrassringLocation(item) {
  const directLocation = extractBrassringQuestionValue(item, "location");
  if (directLocation) return directLocation;

  const city = extractBrassringQuestionValue(item, "city");
  const state = extractBrassringQuestionValue(item, "state");
  const country = extractBrassringQuestionValue(item, "country");
  const combinedLocation = [city, state, country].filter(Boolean).join(", ");
  if (combinedLocation) return combinedLocation;

  const jobTitle = extractBrassringQuestionValue(item, "jobtitle");
  const titleLocation = jobTitle.includes(" - ") ? cleanBrassringText(jobTitle.split(" - ").pop()) : "";
  const latitude = extractBrassringQuestionValue(item, "latitude");
  const longitude = extractBrassringQuestionValue(item, "longitude");

  if (titleLocation && latitude && longitude) return `${titleLocation} - ${latitude}, ${longitude}`;
  if (titleLocation) return titleLocation;
  if (latitude && longitude) return `${latitude}, ${longitude}`;
  return null;
}

function buildBrassringPostingUrl(config, item) {
  const itemUrl = cleanBrassringText(item?.Link || "");
  if (itemUrl) return itemUrl;

  const reqId = extractBrassringQuestionValue(item, "reqid");
  if (!reqId) return config.boardUrl;
  return (
    "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?" +
    `partnerid=${encodeURIComponent(config.partnerId)}&siteid=${encodeURIComponent(config.siteId)}` +
    `&PageType=JobDetails&jobid=${encodeURIComponent(reqId)}`
  );
}


async function fetchBrassringMatchedJobs(config) {
  const boardRes = await fetchWithAtsRateLimit("brassring", BRASSRING_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });
  if (!boardRes.ok) {
    const body = await boardRes.text();
    throw new Error(`BrassRing board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
  }

  const finalBoardUrl = String(boardRes.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalBoardUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "sjobs.brassring.com" && finalHost !== "www.sjobs.brassring.com") {
    throw new Error(`BrassRing URL redirected to unexpected host: ${finalBoardUrl}`);
  }

  const pageHtml = await boardRes.text();
  const requestVerificationToken = extractBrassringHiddenInput(pageHtml, "__RequestVerificationToken");
  const encryptedSessionValue = extractBrassringHiddenInput(pageHtml, "CookieValue");
  const rftHeaderValue = requestVerificationToken || extractBrassringHiddenInput(pageHtml, "hdRft");
  const cookieHeader = extractCookieHeaderFromResponse(boardRes);
  const companyName = extractBrassringCompanyName(pageHtml);

  const payload = {
    PartnerId: config.partnerId,
    SiteId: config.siteId,
    Keyword: "",
    Location: "",
    LocationCustomSolrFields: "Location",
    FacetFilterFields: null,
    TurnOffHttps: false,
    Latitude: 0,
    Longitude: 0,
    PowerSearchOptions: { PowerSearchOption: [] },
    encryptedsessionvalue: encryptedSessionValue
  };

  const headers = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json; charset=utf-8",
    Origin: "https://sjobs.brassring.com",
    Referer: config.boardUrl,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  };
  if (rftHeaderValue) headers.RFT = rftHeaderValue;
  if (cookieHeader) headers.Cookie = cookieHeader;

  const res = await fetchWithAtsRateLimit("brassring", BRASSRING_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BrassRing MatchedJobs request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const responseJson = await res.json();
  return { responseJson, companyName };
}

function parseBrassringPostingsFromApi(companyNameForPostings, config, responseJson) {
  const jobs = Array.isArray(responseJson?.Jobs?.Job) ? responseJson.Jobs.Job : [];
  const postings = [];
  const seenUrls = new Set();
  const seenIds = new Set();

  for (const row of jobs) {
    const item = row && typeof row === "object" ? row : {};
    const reqId = extractBrassringQuestionValue(item, "reqid");
    if (reqId && seenIds.has(reqId)) continue;

    const jobUrl = buildBrassringPostingUrl(config, item);
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    postings.push({
      company_name: companyNameForPostings,
      position_name: extractBrassringQuestionValue(item, "jobtitle") || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: extractBrassringQuestionValue(item, "lastupdated") || null,
      location: extractBrassringLocation(item),
      department: extractBrassringQuestionValue(item, "department") || null
    });
    seenUrls.add(jobUrl);
    if (reqId) seenIds.add(reqId);
  }

  return postings;
}

function parseBrassringCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "sjobs.brassring.com" && host !== "www.sjobs.brassring.com") return null;

  const partnerId = String(parsed.searchParams?.get("partnerid") || "").trim();
  const siteId = String(parsed.searchParams?.get("siteid") || "").trim();
  if (!partnerId || !siteId) return null;

  const boardUrl =
    `https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=${encodeURIComponent(partnerId)}` +
    `&siteid=${encodeURIComponent(siteId)}`;
  return {
    host,
    partnerId,
    siteId,
    boardUrl,
    apiUrl: "https://sjobs.brassring.com/TgNewUI/Search/Ajax/MatchedJobs"
  };
}

async function collectPostingsForBrassringCompany(company) {
  const config = parseBrassringCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const { responseJson, companyName } = await fetchBrassringMatchedJobs(config);
  const companyNameForPostings =
    normalizedCompanyName ||
    String(companyName || "").trim() ||
    `${String(config.partnerId || "").trim()}_${String(config.siteId || "").trim()}`;
  return parseBrassringPostingsFromApi(companyNameForPostings, config, responseJson);
}

module.exports = { collectPostingsForBrassringCompany, parseBrassringCompany };
