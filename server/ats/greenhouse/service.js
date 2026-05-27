const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const GREENHOUSE_API_URL_BASE = "https://boards-api.greenhouse.io/v1/boards";
const GREENHOUSE_RATE_LIMIT_WAIT_MS = 60 * 1000;

function extractGreenhouseLocationName(posting) {
  const nestedLocation = String(posting?.location?.name || "").trim();
  if (nestedLocation) return nestedLocation;

  const flatLocation = String(posting?.location || "").trim();
  return flatLocation || null;
}

async function collectPostingsForGreenhouseCompany(company) {
  const config = parseGreenhouseCompany(company.url_string);
  if (!config) return [];

  const response = await fetchGreenhouseJobBoard(config.boardToken);
  const jobPostings = Array.isArray(response?.jobs) ? response.jobs : [];
  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings =
    normalizedCompanyName && normalizedCompanyName.toLowerCase() !== "job-boards"
      ? normalizedCompanyName
      : config.boardTokenLower;

  const collected = [];
  for (const posting of jobPostings) {
    const jobUrl = String(posting?.absolute_url || "").trim();
    if (!jobUrl) continue;

    collected.push({
      company_name: companyNameForPostings,
      position_name: String(posting?.title || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: String(posting?.updated_at || posting?.first_published || "").trim() || null,
      location: extractGreenhouseLocationName(posting)
    });
  }

  return collected;
}

function parseGreenhouseSeededCompanySource(urlString) {
  const parsed = parseUrl(urlString);
  const host = String(parsed?.hostname || "").toLowerCase();
  if (host !== "job-boards.greenhouse.io" && host !== "boards.greenhouse.io") return null;
  return parseGreenhouseCompany(urlString);
}

function parseGreenhouseCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;
  const [boardToken = ""] = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (!boardToken) return null;

  return {
    boardToken,
    boardTokenLower: boardToken.toLowerCase()
  };
}

async function fetchGreenhouseJobBoard(boardToken) {
  const encodedBoardToken = encodeURIComponent(boardToken);
  const res = await fetchWithAtsRateLimit(
    "greenhouse",
    GREENHOUSE_RATE_LIMIT_WAIT_MS,
    `${GREENHOUSE_API_URL_BASE}/${encodedBoardToken}/jobs?content=true`,
    {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Greenhouse request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

module.exports = { collectPostingsForGreenhouseCompany, parseGreenhouseSeededCompanySource };