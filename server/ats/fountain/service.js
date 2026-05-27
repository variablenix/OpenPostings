const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const FOUNTAIN_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parseFountainCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "web.fountain.com" && host !== "www.web.fountain.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length < 4 || pathParts[0].toLowerCase() !== "c") return null;

  const companyPath = pathParts.slice(0, 4);
  const companySlug = String(pathParts[1] || "").trim();
  if (!companySlug) return null;

  const boardPath = companyPath.join("/");
  const boardUrl = `${parsed.protocol}//${parsed.host}/${boardPath}`;

  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    boardUrl,
    apiUrl: `${boardUrl}.json`
  };
}

function parseFountainPostingsFromApi(companyNameForPostings, config, responseJson) {
  const openings = Array.isArray(responseJson?.openings) ? responseJson.openings : [];
  const postings = [];
  const seenUrls = new Set();

  for (const opening of openings) {
    const item = opening && typeof opening === "object" ? opening : {};
    const toParam = String(item?.to_param || "").trim();
    const itemUrl = toParam ? `${config.boardUrl}/${toParam}` : config.boardUrl;
    if (!itemUrl || seenUrls.has(itemUrl)) continue;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.title || "").trim() || "Untitled Position",
      job_posting_url: itemUrl,
      posting_date:
        String(item?.posted_at || item?.created_at || item?.updated_at || item?.published_at || "").trim() || null,
      location:
        String(item?.location_name || item?.location_address || "").trim() || null,
      employment_type: String(item?.job_type || "").trim() || null
    });
    seenUrls.add(itemUrl);
  }

  return postings;
}

async function collectPostingsForFountainCompany(company) {
  const config = parseFountainCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySlugLower;
  const responseJson = await fetchFountainJobBoard(config);
  return parseFountainPostingsFromApi(companyNameForPostings, config, responseJson);
}

async function fetchFountainJobBoard(config) {
  const res = await fetchWithAtsRateLimit("fountain", FOUNTAIN_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fountain API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

module.exports = { collectPostingsForFountainCompany, parseFountainCompany };