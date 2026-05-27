const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const LEVER_API_URL_BASE = "https://api.lever.co/v0/postings";
const LEVER_RATE_LIMIT_WAIT_MS = 60 * 1000;

function extractLeverLocationName(posting) {
  const allLocations = Array.isArray(posting?.categories?.allLocations) ? posting.categories.allLocations : [];
  const normalizedAllLocations = allLocations
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  if (normalizedAllLocations.length > 0) {
    return normalizedAllLocations.join(" / ");
  }

  const location = String(posting?.categories?.location || "").trim();
  return location || null;
}

async function collectPostingsForLeverCompany(company) {
  const config = parseLeverCompany(company.url_string);
  if (!config) return [];

  const response = await fetchLeverJobBoard(config.organization);
  const jobPostings = Array.isArray(response) ? response : [];
  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings =
    normalizedCompanyName && normalizedCompanyName.toLowerCase() !== "jobs"
      ? normalizedCompanyName
      : config.organizationLower;

  const collected = [];
  for (const posting of jobPostings) {
    const jobUrl = String(posting?.hostedUrl || "").trim();
    if (!jobUrl) continue;

    const createdAt = Number(posting?.createdAt || 0);
    const postingDate =
      Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt).toISOString() : null;

    collected.push({
      company_name: companyNameForPostings,
      position_name: String(posting?.text || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: extractLeverLocationName(posting)
    });
  }

  return collected;
}

function parseLeverSeededCompanySource(urlString) {
  const parsed = parseUrl(urlString);
  const host = String(parsed?.hostname || "").toLowerCase();
  if (host !== "jobs.lever.co") return null;
  return parseLeverCompany(urlString);
}

function parseLeverCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;
  const [organization = ""] = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (!organization) return null;

  return {
    organization,
    organizationLower: organization.toLowerCase()
  };
}


async function fetchLeverJobBoard(organization) {
  const encodedOrganization = encodeURIComponent(organization);
  const res = await fetchWithAtsRateLimit(
    "lever",
    LEVER_RATE_LIMIT_WAIT_MS,
    `${LEVER_API_URL_BASE}/${encodedOrganization}?mode=json`,
    {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lever request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

module.exports = { collectPostingsForLeverCompany, parseLeverSeededCompanySource };