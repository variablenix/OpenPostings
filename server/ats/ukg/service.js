const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const UKG_PAGE_SIZE = 50;
const UKG_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

function parseUkgCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".rec.pro.ukg.net")) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const jobBoardIndex = pathParts.findIndex((part) => part.toLowerCase() === "jobboard");
  if (jobBoardIndex <= 0 || jobBoardIndex + 1 >= pathParts.length) return null;

  const companyId = pathParts[jobBoardIndex - 1];
  const boardId = pathParts[jobBoardIndex + 1];
  if (!companyId || !boardId) return null;

  return {
    host,
    companyId,
    companyIdLower: companyId.toLowerCase(),
    boardId,
    baseBoardUrl: `${parsed.protocol}//${parsed.host}/${companyId}/JobBoard/${boardId}`
  };
}

async function fetchUkgSearchResults(config, top, skip) {
  const apiUrl = `${String(config?.baseBoardUrl || "").replace(/\/+$/, "")}/JobBoardView/LoadSearchResults`;
  const payload = buildUkgSearchPayload(top, skip);

  const res = await fetchWithAtsRateLimit("ukg", UKG_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`UKG request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

function buildUkgSearchPayload(top, skip) {
  return {
    opportunitySearch: {
      Top: Number(top || UKG_PAGE_SIZE),
      Skip: Number(skip || 0),
      QueryString: "",
      OrderBy: [
        {
          Value: "postedDateDesc",
          PropertyName: "PostedDate",
          Ascending: false
        }
      ],
      Filters: [
        { t: "TermsSearchFilterDto", fieldName: 4, extra: null, values: [] },
        { t: "TermsSearchFilterDto", fieldName: 5, extra: null, values: [] },
        { t: "TermsSearchFilterDto", fieldName: 6, extra: null, values: [] },
        { t: "TermsSearchFilterDto", fieldName: 37, extra: null, values: [] }
      ]
    },
    matchCriteria: {
      PreferredJobs: [],
      Educations: [],
      LicenseAndCertifications: [],
      Skills: [],
      hasNoLicenses: false,
      SkippedSkills: []
    }
  };
}

function extractUKGLocationName(opportunity) {
  const locations = Array.isArray(opportunity?.Locations) ? opportunity.Locations : [];
  const values = [];
  const seen = new Set();

  for (const location of locations) {
    const item = location && typeof location === "object" ? location : {};
    const address = item.Address && typeof item.Address === "object" ? item.Address : {};
    const city = String(address.City || "").trim();
    const state = String(address?.State?.Code || "").trim();
    const country = String(address?.Country?.Name || "").trim();
    const fallback = String(item.LocalizedDescription || item.LocalizedName || "").trim();

    const cityState = [city, state].filter(Boolean).join(", ");
    let label = "";
    if (cityState && country) {
      label = `${cityState}, ${country}`;
    } else if (cityState) {
      label = cityState;
    } else if (fallback) {
      label = fallback;
    } else if (country) {
      label = country;
    }

    const normalized = label.toLowerCase();
    if (!label || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(label);
  }

  return values.length > 0 ? values.join(" / ") : null;
}


async function collectPostingsForUkgCompany(company) {
  const config = parseUkgCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyIdLower;
  const postings = [];
  const seenIds = new Set();
  let skip = 0;

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const response = await fetchUkgSearchResults(config, UKG_PAGE_SIZE, skip);
    const opportunities = Array.isArray(response?.opportunities) ? response.opportunities : [];
    if (opportunities.length === 0) break;

    for (const opportunity of opportunities) {
      const opportunityId = String(opportunity?.Id || "").trim();
      if (!opportunityId || seenIds.has(opportunityId)) continue;

      postings.push({
        company_name: companyNameForPostings,
        position_name: String(opportunity?.Title || "").trim() || "Untitled Position",
        job_posting_url: `${config.baseBoardUrl}/OpportunityDetail?opportunityId=${encodeURIComponent(opportunityId)}`,
        posting_date: String(opportunity?.PostedDate || "").trim() || null,
        location: extractUKGLocationName(opportunity)
      });
      seenIds.add(opportunityId);
    }

    const totalCount = Number(response?.totalCount);
    if (opportunities.length < UKG_PAGE_SIZE) break;
    if (Number.isFinite(totalCount) && skip + UKG_PAGE_SIZE >= totalCount) break;
    skip += UKG_PAGE_SIZE;
  }

  return postings;
}

module.exports = { collectPostingsForUkgCompany, parseUkgCompany };
