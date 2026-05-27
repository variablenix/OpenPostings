const { normalizeBoolean } = require("../../helpers/normalize-numbers.js");
const { fetchWithAtsRateLimit } = require("../../services/queue.js");
const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");

const ASHBY_JOB_BOARD_API_URL = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams";
const ASHBY_JOB_POSTING_API_URL = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting";
const ASHBY_RATE_LIMIT_WAIT_MS = 60 * 1000;
// Legacy list query fallback when HTML app data is unavailable.
const ASHBY_JOB_BOARD_QUERY = `
  query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
    jobBoard: jobBoardWithTeams(
      organizationHostedJobsPageName: $organizationHostedJobsPageName
    ) {
      teams {
        id
        name
        externalName
        parentTeamId
        __typename
      }
      jobPostings {
        id
        title
        teamId
        locationId
        locationName
        workplaceType
        employmentType
        secondaryLocations {
          ...JobPostingSecondaryLocationParts
          __typename
        }
        compensationTierSummary
        __typename
      }
      __typename
    }
  }

  fragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {
    locationId
    locationName
    __typename
  }
`;

const ASHBY_JOB_POSTING_QUERY = `
  query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
    jobPosting(
      organizationHostedJobsPageName: $organizationHostedJobsPageName
      jobPostingId: $jobPostingId
    ) {
      id
      locationName
      secondaryLocationNames
      descriptionHtml
    }
  }
`;

function parseAshbyCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;
  const [organizationHostedJobsPageName = ""] = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (!organizationHostedJobsPageName) return null;

  return {
    organizationHostedJobsPageName,
    organizationHostedJobsPageNameLower: organizationHostedJobsPageName.toLowerCase()
  };
}

function buildAshbyJobBoardUrl(organizationHostedJobsPageName) {
  if (!organizationHostedJobsPageName) return "";
  return `https://jobs.ashbyhq.com/${organizationHostedJobsPageName}`;
}

// Legacy GraphQL list endpoint.
async function fetchAshbyJobBoard(organizationHostedJobsPageName) {
  const res = await fetchWithAtsRateLimit("ashby", ASHBY_RATE_LIMIT_WAIT_MS, ASHBY_JOB_BOARD_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      operationName: "ApiJobBoardWithTeams",
      variables: {
        organizationHostedJobsPageName
      },
      query: ASHBY_JOB_BOARD_QUERY
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ashby request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const data = await res.json();
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    const firstError = String(data.errors[0]?.message || "Unknown Ashby GraphQL error");
    throw new Error(`Ashby GraphQL error: ${firstError}`);
  }

  return data;
}

async function fetchAshbyJobBoardPageHtml(organizationHostedJobsPageName) {
  const boardUrl = buildAshbyJobBoardUrl(organizationHostedJobsPageName);
  if (!boardUrl) return "";
  const res = await fetchWithAtsRateLimit("ashby", ASHBY_RATE_LIMIT_WAIT_MS, boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ashby job board page request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res.text();
}

function buildAshbyJobUrl(organizationHostedJobsPageName, jobId) {
  if (!organizationHostedJobsPageName || !jobId) return "";
  return `https://jobs.ashbyhq.com/${organizationHostedJobsPageName}/${jobId}`;
}

function extractJsonObjectAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const startIndex = source.indexOf("{", markerIndex + marker.length);
  if (startIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseAshbyAppDataFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  if (!source) return null;

  const markers = ["window.__appData =", "window.__appData="];
  for (const marker of markers) {
    const jsonObjectText = extractJsonObjectAfterMarker(source, marker);
    if (!jsonObjectText) continue;
    try {
      return JSON.parse(jsonObjectText);
    } catch {
      continue;
    }
  }

  return null;
}

function extractAshbyJobPostingsFromHtml(pageHtml) {
  const appData = parseAshbyAppDataFromHtml(pageHtml);
  const jobPostings = Array.isArray(appData?.jobBoard?.jobPostings) ? appData.jobBoard.jobPostings : [];
  return jobPostings;
}

async function fetchAshbyJobPostingDetails(organizationHostedJobsPageName, jobPostingId) {
  const res = await fetchWithAtsRateLimit("ashby", ASHBY_RATE_LIMIT_WAIT_MS, ASHBY_JOB_POSTING_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: {
        organizationHostedJobsPageName,
        jobPostingId
      },
      query: ASHBY_JOB_POSTING_QUERY
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ashby job posting request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const data = await res.json();
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    const firstError = String(data.errors[0]?.message || "Unknown Ashby GraphQL error");
    throw new Error(`Ashby GraphQL error: ${firstError}`);
  }
  return data?.data?.jobPosting || null;
}

function extractAshbyPostingDate(posting) {
  const updatedAt = String(posting?.updatedAt || "").trim();
  if (updatedAt) return updatedAt;
  const publishedDate = String(posting?.publishedDate || "").trim();
  if (publishedDate) return publishedDate;
  return null;
}

function normalizeAshbyJobDescription(descriptionHtml) {
  const source = String(descriptionHtml || "").trim();
  if (!source) return null;

  const text = decodeHtmlEntities(
    source
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "- ")
      .replace(/<\/\s*(p|div|h[1-6]|li|ul|ol|section|article|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}


async function collectPostingsForAshbyCompany(company, options = {}) {
  const config = parseAshbyCompany(company.url_string);
  if (!config) return [];

  const shouldDownloadDescriptions = normalizeBoolean(options?.downloadJobDescriptions, true);
  let jobPostings = [];
  try {
    const pageHtml = await fetchAshbyJobBoardPageHtml(config.organizationHostedJobsPageName);
    jobPostings = extractAshbyJobPostingsFromHtml(pageHtml);
  } catch {
    jobPostings = [];
  }

  if (!Array.isArray(jobPostings) || jobPostings.length === 0) {
    const response = await fetchAshbyJobBoard(config.organizationHostedJobsPageName);
    jobPostings = Array.isArray(response?.data?.jobBoard?.jobPostings) ? response.data.jobBoard.jobPostings : [];
  }

  const collected = [];
  for (const posting of jobPostings) {
    const jobId = String(posting?.id || "").trim();
    if (!jobId) continue;

    const jobUrl = buildAshbyJobUrl(config.organizationHostedJobsPageName, jobId);
    if (!jobUrl) continue;

    const boardLocation = extractAshbyLocationName(posting);
    let location = boardLocation;
    let jobDescription = null;
    let descriptionForInference = "";
    if (shouldDownloadDescriptions || !location) {
      try {
        const details = await fetchAshbyJobPostingDetails(config.organizationHostedJobsPageName, jobId);
        const detailsDescription = String(details?.descriptionHtml || "").trim();
        if (detailsDescription) descriptionForInference = detailsDescription;
        if (shouldDownloadDescriptions) {
          jobDescription = normalizeAshbyJobDescription(detailsDescription);
        }
        if (!location) {
          const detailsLocation = extractAshbyLocationName(details);
          location = detailsLocation || null;
        }
      } catch {
        if (shouldDownloadDescriptions) {
          jobDescription = null;
        }
      }
    }
    if (!location) {
      const inferredLocation = inferAshbyLocationFromDescription(
        descriptionForInference || jobDescription || String(posting?.descriptionHtml || "").trim()
      );
      if (inferredLocation) location = inferredLocation;
    }

    collected.push({
      company_name: company.company_name,
      position_name: String(posting?.title || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: extractAshbyPostingDate(posting),
      job_description: jobDescription,
      location: location || null
    });
  }

  return collected;
}


function inferAshbyLocationFromDescription(jobDescription) {
  const description = String(jobDescription || "").trim();
  if (!description) return null;

  const normalizeLocationCandidate = (value) =>
    String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^\W+/, "")
      .replace(/[;,:.\s]+$/g, "")
      .replace(/\s+(?:type|hours|employment|department|team|salary|compensation)\s*[:\-].*$/i, "")
      .trim();

  const htmlLocationPatterns = [
    /<(?:strong|b)>\s*(?:job\s*)?location\s*:?\s*<\/(?:strong|b)>\s*([^<]{2,160})/i,
    /\b(?:job\s*)?location\s*[:\-]\s*([^<\n\r]{2,160})/i
  ];
  for (const pattern of htmlLocationPatterns) {
    const rawCandidate = String(description.match(pattern)?.[1] || "").trim();
    if (!rawCandidate) continue;
    const candidate = normalizeLocationCandidate(decodeHtmlEntities(rawCandidate));
    if (candidate) return candidate;
  }

  const plainText = decodeHtmlEntities(
    description
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (!plainText) return null;

  const lines = plainText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const locationLineMatch = line.match(/^(?:job\s*)?location\s*[:\-]\s*(.+)$/i);
    if (!locationLineMatch?.[1]) continue;
    const candidate = normalizeLocationCandidate(locationLineMatch[1]);
    if (candidate) return candidate;
  }

  const patterns = [
    /\b(?:this role|this position|the role)\s+is\s+based\s+in\s+([^\n]{2,160})/i,
    /\b(?:based|located)\s+in\s+([^\n]{2,160})/i,
    /\blocation\s*[:\-]\s*([^\n]{2,160})/i
  ];

  for (const pattern of patterns) {
    const rawCandidate = String(plainText.match(pattern)?.[1] || "").trim();
    if (!rawCandidate) continue;

    let candidate = normalizeLocationCandidate(rawCandidate)
      .replace(/\s+(?:or|and)\s+remote\b.*$/i, "")
      .replace(/\s+with\b.*$/i, "")
      .trim();
    if (!candidate) continue;

    candidate = candidate
      .split("/")
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / ");
    if (!candidate) continue;

    return candidate;
  }

  return null;
}



function extractAshbyLocationName(posting) {
  const clean = (value) => String(value || "").trim();
  const names = [];
  const primary = clean(posting?.locationName || posting?.locationExternalName || posting?.location?.name);
  if (primary) names.push(primary);

  const secondaryNames = Array.isArray(posting?.secondaryLocationNames) ? posting.secondaryLocationNames : [];
  for (const secondaryName of secondaryNames) {
    const name = clean(secondaryName);
    if (!name) continue;
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }

  const secondary = Array.isArray(posting?.secondaryLocations) ? posting.secondaryLocations : [];
  for (const location of secondary) {
    const name = clean(location?.locationName || location?.name || location?.displayName);
    if (!name) continue;
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }

  const alternateSecondary = Array.isArray(posting?.locations) ? posting.locations : [];
  for (const location of alternateSecondary) {
    const name = clean(location?.locationName || location?.name || location?.displayName || location);
    if (!name) continue;
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }

  return names.length > 0 ? names.join(", ") : null;
}

function parseAshbySeededCompanySource(urlString) {
  const parsed = parseUrl(urlString);
  const host = String(parsed?.hostname || "").toLowerCase();
  if (host !== "jobs.ashbyhq.com") return null;
  return parseAshbyCompany(urlString);
}


module.exports = { collectPostingsForAshbyCompany, parseAshbySeededCompanySource, inferAshbyLocationFromDescription };
