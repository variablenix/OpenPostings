const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const TALENTREEF_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;
const TALENTREEF_SEARCH_SOURCE_FIELDS = [
  "positionType",
  "category",
  "socialRecruitingAttribute1",
  "description",
  "address",
  "jobId",
  "clientId",
  "clientName",
  "brandId",
  "brand",
  "clientName",
  "location",
  "internalOrExternal",
  "url",
  "postingUuid",
  "isSalaried",
  "minCompensation",
  "maxCompensation",
  "pubCompensation"
];

async function collectPostingsForTalentreefCompany(company) {
  const config = parseTalentreefCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyNameLower;
  const aliasResponse = await fetchTalentreefAlias(config);
  const { clientId, brand } = extractTalentreefAliasData(aliasResponse);
  if (!clientId) return [];

  const collected = [];
  const seenUrls = new Set();
  const pageSize = 100;
  let totalHits = null;

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const from = page * pageSize;
    const responseJson = await fetchTalentreefSearchResults(config, clientId, brand, from, pageSize);
    const batch = parseTalentreefPostingsFromSearchResponse(companyNameForPostings, config, clientId, responseJson);
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    const totalRaw = responseJson?.hits?.total;
    const totalValue =
      typeof totalRaw === "number"
        ? totalRaw
        : totalRaw && typeof totalRaw === "object"
          ? Number(totalRaw?.value || 0)
          : 0;
    if (Number.isFinite(totalValue) && totalValue >= 0) {
      totalHits = totalValue;
    }
    if (batch.length < pageSize) break;
    if (Number.isFinite(totalHits) && from + pageSize >= Number(totalHits)) break;
  }

  return collected;
}

function parseTalentreefCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "apply.jobappnetwork.com" && host !== "www.apply.jobappnetwork.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const companyName = String(pathParts[0] || "").trim();
  if (!companyName) return null;

  return {
    host,
    companyName,
    companyNameLower: companyName.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    boardUrl: `${parsed.protocol}//${parsed.host}/${companyName}`,
    searchApiUrl: "https://prod-kong.internal.talentreef.com/apply/proxy-es/search-en-us/posting/_search"
  };
}

function buildTalentreefAliasUrl(companyName) {
  const normalized = String(companyName || "").trim();
  if (!normalized) return "";
  return `https://prod-kong.internal.talentreef.com/apply/careerPages/alias/${encodeURIComponent(normalized)}`;
}

function buildTalentreefAliasCandidates(companyName) {
  const normalized = String(companyName || "").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) return [];

  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const next = String(value || "").trim().replace(/^\/+|\/+$/g, "");
    if (!next) return;
    const dedupeKey = next.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push(next);
  };

  push(normalized);
  push(normalized.toLowerCase());

  const parts = normalized.split("-").map((part) => String(part || "").trim()).filter(Boolean);
  if (parts.length > 1) {
    push(parts[0]);
    push(parts[parts.length - 1]);
    push(parts.join(""));
  }

  return candidates;
}

function extractTalentreefCompanyFromResolvedBoardUrl(resolvedBoardUrl) {
  const resolved = String(resolvedBoardUrl || "").trim();
  if (!resolved) return "";
  try {
    const parsed = new URL(resolved);
    const host = String(parsed.hostname || "").toLowerCase();
    if (host !== "apply.jobappnetwork.com" && host !== "www.apply.jobappnetwork.com") return "";
    const pathParts = String(parsed.pathname || "")
      .split("/")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return String(pathParts[0] || "").trim();
  } catch {
    return "";
  }
}



function extractTalentreefAliasData(aliasResponse) {
  if (!Array.isArray(aliasResponse) || aliasResponse.length === 0) return { clientId: "", brand: "" };
  const firstItem = aliasResponse[0];
  if (!firstItem || typeof firstItem !== "object") return { clientId: "", brand: "" };

  let clientId = "";
  const clients = Array.isArray(firstItem?.clients) ? firstItem.clients : [];
  if (clients.length > 0 && clients[0] && typeof clients[0] === "object") {
    clientId = String(clients[0]?.legacyClientId || clients[0]?.clientId || "").trim();
  }
  if (!clientId) {
    clientId = String(firstItem?.clientId || "").trim();
  }

  let brand = "";
  const brands = Array.isArray(firstItem?.brands) ? firstItem.brands : [];
  if (brands.length > 0) {
    const firstBrand = brands[0];
    if (firstBrand && typeof firstBrand === "object") {
      brand = String(firstBrand?.name || firstBrand?.brand || firstBrand?.title || "").trim();
    } else {
      brand = String(firstBrand || "").trim();
    }
  }
  if (!brand) {
    brand = String(firstItem?.brand || "").trim();
  }

  return { clientId, brand };
}

function buildTalentreefSearchPayload(clientId, brand = "", from = 0, size = 100) {
  /** @type {Array<{ terms: Record<string, string[]> }>} */
  const filters = [
    {
      terms: {
        "clientId.raw": [String(clientId || "").trim()]
      }
    }
  ];

  const normalizedBrand = String(brand || "").trim();
  if (normalizedBrand) {
    filters.push({
      terms: {
        "brand.raw": [normalizedBrand]
      }
    });
  }

  return {
    from: Number(from || 0),
    size: Number(size || 100),
    _source: TALENTREEF_SEARCH_SOURCE_FIELDS,
    query: {
      bool: {
        filter: filters
      }
    },
    sort: [
      {
        jobId: {
          order: "desc"
        }
      }
    ]
  };
}

function toTitleCaseWords(value) {
  return String(value || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractTalentreefLocationFromUrlSlug(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";

  let pathname = text;
  try {
    pathname = new URL(text, "https://apply.jobappnetwork.com").pathname || text;
  } catch {
    pathname = text;
  }

  const fileName = pathname.split("/").pop() || "";
  const match = fileName.match(/-job-([A-Za-z0-9-]+)-([A-Z]{2})-US-\d+\.html$/i);
  if (!match) return "";

  const city = toTitleCaseWords(String(match[1] || "").replace(/-/g, " "));
  const stateCode = String(match[2] || "").trim().toUpperCase();
  if (!city || !stateCode) return "";
  return `${city}, ${stateCode}`;
}

function extractTalentreefLocation(source = {}) {
  const item = source && typeof source === "object" ? source : {};
  const address = item?.address && typeof item.address === "object" ? item.address : {};
  const city = String(address?.city || item?.city || "").trim();
  const state = String(
    item?.stateOrProvinceFull || item?.stateOrProvince || address?.stateOrProvince || address?.state || ""
  ).trim();
  const cityState = [city, state].filter(Boolean).join(", ");
  if (cityState) return cityState;

  if (item?.location && typeof item.location === "object") {
    const locationName = String(item.location?.name || item.location?.title || item.location?.number || "").trim();
    if (locationName) return locationName;
  }
  if (typeof item?.location === "string" && item.location.trim()) {
    return item.location.trim();
  }

  const fromUrl = extractTalentreefLocationFromUrlSlug(item?.url);
  if (fromUrl) return fromUrl;

  return "";
}

function extractTalentreefJobId(source = {}) {
  const item = source && typeof source === "object" ? source : {};
  const directJobId = String(item?.jobId || item?.postingId || "").trim();
  if (directJobId) return directJobId;

  const urlString = String(item?.url || "").trim();
  if (!urlString) return "";
  const idFromSlug = urlString.match(/-(\d+)\.html(?:$|[?#])/);
  if (idFromSlug?.[1]) return String(idFromSlug[1]).trim();
  const idFromPostingPath = urlString.match(/\/posting\/(\d+)(?:$|[/?#])/i);
  if (idFromPostingPath?.[1]) return String(idFromPostingPath[1]).trim();
  return "";
}

function parseTalentreefBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

function parseTalentreefCompensationAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function extractTalentreefCompensation(source = {}) {
  const isSalaried = parseTalentreefBoolean(source?.isSalaried);
  const payMin = parseTalentreefCompensationAmount(source?.minCompensation);
  const payMax = parseTalentreefCompensationAmount(source?.maxCompensation);
  const hasCompensationValues = Number.isFinite(payMin) || Number.isFinite(payMax);

  const compensationType =
    isSalaried === true ? "salary" : isSalaried === false ? "hourly" : "unknown";
  const payPeriod = isSalaried === true ? "year" : isSalaried === false ? "hour" : null;
  const payRaw = hasCompensationValues
    ? `${payMin !== null ? payMin : ""}${payMax !== null ? `-${payMax}` : ""}${payPeriod ? ` per ${payPeriod}` : ""}`
    : null;

  return {
    compensation_type: compensationType,
    pay_min: payMin,
    pay_max: payMax,
    pay_currency: null,
    pay_period: payPeriod,
    pay_raw: payRaw
  };
}

function buildTalentreefPostingUrl(config, clientId, source = {}) {
  const sourceClientId = String(source?.clientId || "").trim();
  const normalizedClientId = sourceClientId || String(clientId || "").trim();
  const jobId = extractTalentreefJobId(source);
  const baseOrigin = String(config?.baseOrigin || "").replace(/\/+$/, "");
  if (baseOrigin && normalizedClientId && jobId) {
    return `${baseOrigin}/clients/${encodeURIComponent(normalizedClientId)}/posting/${encodeURIComponent(jobId)}`;
  }

  const rawUrl = String(source?.url || "").trim();
  if (!rawUrl || !baseOrigin) return "";
  try {
    return new URL(rawUrl, `${baseOrigin}/`).toString();
  } catch {
    return "";
  }
}

function parseTalentreefPostingsFromSearchResponse(companyNameForPostings, config, clientId, responseJson) {
  const hits = Array.isArray(responseJson?.hits?.hits) ? responseJson.hits.hits : [];
  const postings = [];
  const seenUrls = new Set();

  for (const hit of hits) {
    const source = hit && typeof hit === "object" && hit._source && typeof hit._source === "object" ? hit._source : {};
    const postingUrl = buildTalentreefPostingUrl(config, clientId, source);
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const location = extractTalentreefLocation(source);
    const department = String(source?.department?.name || source?.category || "").trim();
    const jobDescription = String(source?.description || "").trim() || null;
    const compensation = extractTalentreefCompensation(source);

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(source?.title || source?.positionType || "").trim() || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: null,
      job_description: jobDescription,
      compensation_type: compensation.compensation_type,
      pay_min: compensation.pay_min,
      pay_max: compensation.pay_max,
      pay_currency: compensation.pay_currency,
      pay_period: compensation.pay_period,
      pay_raw: compensation.pay_raw,
      location: location || null,
      department: department || null,
      employment_type: String(source?.contractType || "").trim() || null
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}

async function fetchTalentreefAlias(config) {
  const attemptAliasLookup = async (candidate) => {
    const aliasUrl = buildTalentreefAliasUrl(candidate);
    if (!aliasUrl) return { ok: false, status: 0, body: "", json: null };
    const res = await fetchWithAtsRateLimit("talentreef", TALENTREEF_RATE_LIMIT_WAIT_MS, aliasUrl, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, status: Number(res.status || 0), body, json: null };
    }
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(body);
    } catch {
      parsedJson = null;
    }
    return { ok: true, status: Number(res.status || 200), body, json: parsedJson };
  };

  const aliasCandidates = buildTalentreefAliasCandidates(config?.companyName);
  const attemptedCandidates = [];
  let lastFailure = null;

  for (const candidate of aliasCandidates) {
    attemptedCandidates.push(candidate);
    const result = await attemptAliasLookup(candidate);
    if (result.ok) return result.json;
    lastFailure = result;
    if (result.status !== 404) {
      throw new Error(`TalentReef alias request failed (${result.status}): ${String(result.body || "").slice(0, 180)}`);
    }
  }

  try {
    const boardRes = await fetchWithAtsRateLimit("talentreef", TALENTREEF_RATE_LIMIT_WAIT_MS, config.boardUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const resolvedAlias = extractTalentreefCompanyFromResolvedBoardUrl(boardRes?.url);
    const extraCandidates = buildTalentreefAliasCandidates(resolvedAlias).filter((candidate) =>
      !attemptedCandidates.some((attempted) => attempted.toLowerCase() === candidate.toLowerCase())
    );
    for (const candidate of extraCandidates) {
      attemptedCandidates.push(candidate);
      const result = await attemptAliasLookup(candidate);
      if (result.ok) return result.json;
      lastFailure = result;
      if (result.status !== 404) {
        throw new Error(`TalentReef alias request failed (${result.status}): ${String(result.body || "").slice(0, 180)}`);
      }
    }
  } catch (error) {
    if (lastFailure && Number(lastFailure.status) === 404) {
      throw new Error(
        `TalentReef alias request failed (404) after candidates [${attemptedCandidates.join(", ")}]: ${String(lastFailure.body || "").slice(0, 180)}`
      );
    }
    throw error;
  }

  const failureStatus = Number(lastFailure?.status || 0);
  const failureBody = String(lastFailure?.body || "");
  throw new Error(
    `TalentReef alias request failed (${failureStatus || 404}) after candidates [${attemptedCandidates.join(", ")}]: ${failureBody.slice(0, 180)}`
  );
}

async function fetchTalentreefSearchResults(config, clientId, brand, from = 0, size = 100) {
  const payload = buildTalentreefSearchPayload(clientId, brand, from, size);
  const res = await fetchWithAtsRateLimit("talentreef", TALENTREEF_RATE_LIMIT_WAIT_MS, config.searchApiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TalentReef search request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}
module.exports = { collectPostingsForTalentreefCompany, parseTalentreefCompany };
