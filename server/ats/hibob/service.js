const { parseUrl, cleanText, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HIBOB_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parseHibobCompany(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return null;

  const parsed = parseUrl(normalizedUrl);
  if (!parsed || !parsed.protocol || !parsed.host) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".careers.hibob.com")) return null;

  const companySubdomain = host.replace(".careers.hibob.com", "").trim();
  if (!companySubdomain) return null;

  return {
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    apiUrl: `${parsed.protocol}//${parsed.host}/api/job-ad`,
    companySubdomain
  };
}

async function fetchHibobJobBoard(config, boardUrl) {
  const boardResponse = await fetchWithAtsRateLimit("hibob", HIBOB_RATE_LIMIT_WAIT_MS, boardUrl, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!boardResponse.ok) {
    const body = await boardResponse.text();
    throw new Error(`HiBob board request failed (${boardResponse.status}): ${body.slice(0, 180)}`);
  }

  const apiResponse = await fetchWithAtsRateLimit("hibob", HIBOB_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: boardUrl,
      Origin: config.baseOrigin
    }
  });

  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`HiBob API request failed (${apiResponse.status}): ${body.slice(0, 180)}`);
  }
  return apiResponse.json();
}

function parseHibobPostingsFromApi(companyName, config, responseJson) {
  if (!responseJson || typeof responseJson !== "object") return [];
  const postings = [];
  const seenUrls = new Set();
  const jobAds = Array.isArray(responseJson.jobAdDetails) ? responseJson.jobAdDetails : [];

  for (const item of jobAds) {
    if (!item || typeof item !== "object") continue;
    const jobId = cleanText(item.id);
    if (!jobId) continue;

    const postingUrl = cleanText(item.jobUrl) || cleanText(item.absoluteUrl) || cleanText(item.url);
    const urlValue = postingUrl || `${config.baseOrigin}/job/${jobId}`;
    if (!urlValue || seenUrls.has(urlValue)) continue;

    const title = cleanText(item.title) || "Untitled Position";
    const location = cleanText(item.site) || cleanText(item.country) || null;
    const postingDate = cleanText(item.publishedAt) || null;

    postings.push({
      company_name: companyName,
      position_name: title,
      job_posting_url: urlValue,
      posting_date: postingDate,
      location
    });
    seenUrls.add(urlValue);
  }

  return postings;
}

async function collectPostingsForHibobCompany(company) {
  const config = parseHibobCompany(company?.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySubdomain;
  const responseJson = await fetchHibobJobBoard(config, company.url_string);
  return parseHibobPostingsFromApi(companyNameForPostings, config, responseJson);
}

module.exports = { collectPostingsForHibobCompany, parseHibobCompany };