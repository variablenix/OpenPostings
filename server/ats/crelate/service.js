const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit, waitForAtsFixedInterval } = require("../../services/queue");
const CRELATE_RATE_LIMIT_WAIT_MS = 60 * 1000;
const CRELATE_MIN_INTERVAL_MS = 5 * 1000;

function parseCrelateCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (host !== "jobs.crelate.com") return null;
  const pathname = String(parsed.pathname || "");
  const portalMatch = /^\/portal\/(?<portalSlug>[^/?#]+)/i.exec(pathname);
  const portalSlug = String(portalMatch?.groups?.portalSlug || "").trim();
  if (!portalSlug) return null;
  const protocol = parsed.protocol || "https:";
  const portalBasePath = `/portal/${portalSlug}`;
  const boardUrl = `${protocol}//${host}${portalBasePath}`;
  const portalBaseUrl = `${protocol}//${host}${portalBasePath}`;
  return { host, boardUrl, portalBaseUrl };
}

function extractCrelateOrgIdFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const match = /var\s+ORG_ID\s*=\s*["'](?<orgId>[0-9a-fA-F-]{8,})["']\s*;/i.exec(source);
  const orgId = String(match?.groups?.orgId || "").trim();
  return orgId || null;
}

function parseCrelatePostingsFromApi(companyNameForPostings, payload, portalBaseUrl) {
  const source = payload && typeof payload === "object" ? payload : {};
  const jobs = Array.isArray(source?.Jobs) ? source.Jobs : [];
  const postings = [];
  const seenUrls = new Set();
  const normalizedPortalBaseUrl =
    String(portalBaseUrl || "https://jobs.crelate.com/portal").replace(/\/+$/, "");

  for (const item of jobs) {
    if (!item || typeof item !== "object") continue;
    const relativeUrl = String(item?.Url || "").trim();
    let jobPostingUrl = "";
    if (relativeUrl.startsWith("/")) {
      jobPostingUrl = `${normalizedPortalBaseUrl}/job${relativeUrl}`;
    } else if (/^https?:\/\//i.test(relativeUrl)) {
      jobPostingUrl = relativeUrl;
    } else if (relativeUrl) {
      jobPostingUrl = `${normalizedPortalBaseUrl}/job/${relativeUrl.replace(/^\/+/, "")}`;
    }
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) continue;

    const city = String(item?.City ?? item?.city ?? "").trim();
    const state = String(item?.State ?? item?.state ?? item?.Province ?? item?.province ?? "").trim();
    const country = String(item?.Country ?? item?.country ?? "").trim();
    const postalCode = String(item?.PostalCode ?? item?.postalCode ?? item?.ZipCode ?? item?.zipCode ?? "").trim();
    const locationParts = [city, state, country, postalCode].filter(Boolean);
    const location = locationParts.length > 0 ? locationParts.join(", ") : null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.Title || "").trim() || "Untitled Position",
      job_posting_url: jobPostingUrl,
      posting_date: String(item?.LastPostedOnDate || "").trim() || null,
      location
    });
    seenUrls.add(jobPostingUrl);
  }

  return postings;
}

async function collectPostingsForCrelateCompany(company) {
  const config = parseCrelateCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || "crelate";
  const defaultHeaders = {
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  };

  await waitForAtsFixedInterval("crelate", CRELATE_MIN_INTERVAL_MS);
  const boardResponse = await fetchWithAtsRateLimit("crelate", CRELATE_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      ...defaultHeaders,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!boardResponse.ok) {
    const body = await boardResponse.text();
    throw new Error(`Crelate board request failed (${boardResponse.status}): ${body.slice(0, 180)}`);
  }
  const boardHtml = await boardResponse.text();
  const orgId = extractCrelateOrgIdFromHtml(boardHtml);
  if (!orgId) return [];

  const apiUrl = new URL("https://jobs.crelate.com/api/candidateportal/GetAllJobs");
  apiUrl.searchParams.set(
    "requestEnvelope",
    JSON.stringify(
      {
        Locations: null,
        OrganizationId: orgId,
        SearchText: null,
        Tags: null
      },
      null,
      0
    )
  );

  await waitForAtsFixedInterval("crelate", CRELATE_MIN_INTERVAL_MS);
  const apiResponse = await fetchWithAtsRateLimit("crelate", CRELATE_RATE_LIMIT_WAIT_MS, apiUrl.toString(), {
    method: "GET",
    headers: {
      ...defaultHeaders,
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Crelate API request failed (${apiResponse.status}): ${body.slice(0, 180)}`);
  }

  const payload = await apiResponse.json();
  return parseCrelatePostingsFromApi(companyNameForPostings, payload, config.portalBaseUrl);
}

module.exports = { collectPostingsForCrelateCompany, parseCrelateCompany };
