const { parseUrl, decodeBase64Utf8 } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const GEM_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForGemCompany(company) {
  const config = parseGemCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.boardIdLower;
  const responseJson = await fetchGemJobBoard(config);
  return parseGemPostingsFromBatchResponse(companyNameForPostings, config, responseJson);
}


function parseGemCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "jobs.gem.com" && host !== "www.jobs.gem.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const boardId = String(pathParts[0] || "").trim();
  if (!boardId) return null;

  return {
    host,
    boardId,
    boardIdLower: boardId.toLowerCase(),
    boardUrl: `${parsed.protocol}//${parsed.host}/${boardId}`,
    apiUrl: "https://jobs.gem.com/api/public/graphql/batch"
  };
}


function extractGemNumericJobId(rawId) {
  const direct = String(rawId || "").trim();
  if (/^\d+$/.test(direct)) return direct;

  const decoded = decodeBase64Utf8(direct);
  const match = decoded.match(/:(\d{2,})$/);
  return String(match?.[1] || "").trim();
}

function buildGemJobPostingUrl(config, posting) {
  const boardUrl = String(config?.boardUrl || "").replace(/\/+$/, "");
  const item = posting && typeof posting === "object" ? posting : {};
  const extId = String(item?.extId || "").trim();
  const numericId = extractGemNumericJobId(item?.id);
  const fallbackId = String(item?.id || "").trim();
  // Prefer Gem's opaque extId token; numeric decoded IDs can produce stale/bad URLs.
  const identifier = extId || numericId || fallbackId;
  if (!boardUrl || !identifier) return boardUrl || "";
  return `${boardUrl}/${encodeURIComponent(identifier)}`;
}

function extractGemLocationLabel(posting) {
  const item = posting && typeof posting === "object" ? posting : {};
  const locations = Array.isArray(item?.locations) ? item.locations : [];
  const values = [];
  const seen = new Set();

  for (const location of locations) {
    const source = location && typeof location === "object" ? location : {};
    const name = String(source?.name || "").trim();
    const city = String(source?.city || "").trim();
    const country = String(source?.isoCountry || "").trim();
    const label = name || [city, country].filter(Boolean).join(", ");
    const normalized = label.toLowerCase();
    if (!label || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(label);
  }

  if (values.length > 0) return values.join(" / ");

  const locationType = String(item?.job?.locationType || "").trim().toUpperCase();
  if (locationType.includes("REMOTE")) return "Remote";
  return null;
}

function parseGemPostingsFromBatchResponse(companyNameForPostings, config, responseJson) {
  const payload = Array.isArray(responseJson) ? responseJson : [];
  let jobPostings = [];
  for (const item of payload) {
    const data = item && typeof item === "object" ? item.data : null;
    const external = data && typeof data === "object" ? data.oatsExternalJobPostings : null;
    const postings = external && typeof external === "object" ? external.jobPostings : null;
    if (!Array.isArray(postings)) continue;
    jobPostings = postings;
    break;
  }

  const collected = [];
  const seenUrls = new Set();

  for (const posting of jobPostings) {
    const item = posting && typeof posting === "object" ? posting : {};
    const postingUrl = buildGemJobPostingUrl(config, item);
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const department = String(item?.job?.department?.name || "").trim();
    collected.push({
      company_name: companyNameForPostings,
      position_name: String(item?.title || "").trim() || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: null,
      location: extractGemLocationLabel(item),
      department: department || null
    });
    seenUrls.add(postingUrl);
  }

  return collected;
}


async function fetchGemJobBoard(config) {
  const payload = [
    {
      operationName: "JobBoardTheme",
      variables: {
        boardId: config.boardId
      },
      query:
        "query JobBoardTheme($boardId: String!) { publicBrandingTheme(externalId: $boardId) { id theme __typename } }"
    },
    {
      operationName: "JobBoardList",
      variables: {
        boardId: config.boardId
      },
      query:
        "query JobBoardList($boardId: String!) { oatsExternalJobPostings(boardId: $boardId) { jobPostings { id extId title locations { id name city isoCountry isRemote extId __typename } job { id department { id name extId __typename } locationType employmentType __typename } __typename } __typename } jobBoardExternal(vanityUrlPath: $boardId) { id teamDisplayName descriptionHtml pageTitle __typename } }"
    }
  ];

  const res = await fetchWithAtsRateLimit("gem", GEM_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gem API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const responseJson = await res.json();
  if (!Array.isArray(responseJson)) {
    throw new Error("Gem API response is not a JSON array");
  }

  return responseJson;
}

module.exports = { collectPostingsForGemCompany, parseGemCompany };
