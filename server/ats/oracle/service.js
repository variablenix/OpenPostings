const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const MAX_PAGES_PER_COMPANY = 25;
const ORACLE_RATE_LIMIT_WAIT_MS = 60 * 1000;
const ORACLE_EXPAND_VALUE = [
  "requisitionList.workLocation",
  "requisitionList.otherWorkLocations",
  "requisitionList.secondaryLocations",
  "flexFieldsFacet.values",
  "requisitionList.requisitionFlexFields"
].join(",");
const ORACLE_FACETS_VALUE =
  "LOCATIONS;WORK_LOCATIONS;WORKPLACE_TYPES;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS";

async function collectPostingsForOracleCompany(company) {
  const config = parseOracleCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || "";
  const pageSize = 25;
  const seenUrls = new Set();
  const collected = [];

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const offset = page * pageSize;
    const responseJson = await fetchOracleJobRequisitionsPage(config, offset, pageSize);
    const batch = parseOraclePostingsFromApi(companyNameForPostings, config, responseJson);

    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      if (!String(posting?.posting_date || "").trim()) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    if (!Boolean(responseJson?.hasMore)) break;
    if (batch.length === 0) break;
  }

  return collected;
}


function parseOracleCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".oraclecloud.com")) return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const loweredPathParts = pathParts.map((part) => part.toLowerCase());

  const candidateExperienceIndex = loweredPathParts.indexOf("candidateexperience");
  if (candidateExperienceIndex < 0) return null;

  let language = "en";
  if (candidateExperienceIndex + 1 < pathParts.length) {
    const maybeLanguage = String(pathParts[candidateExperienceIndex + 1] || "").trim();
    if (maybeLanguage && maybeLanguage.toLowerCase() !== "sites") {
      language = maybeLanguage;
    }
  }

  let siteNumber = "";
  const sitesIndex = loweredPathParts.indexOf("sites", candidateExperienceIndex + 1);
  if (sitesIndex >= 0 && sitesIndex + 1 < pathParts.length) {
    siteNumber = String(pathParts[sitesIndex + 1] || "").trim();
  }
  if (!siteNumber) {
    siteNumber = String(parsed.searchParams?.get("siteNumber") || "").trim();
  }
  if (!siteNumber) {
    siteNumber = "CX";
  }

  const safeLanguage = language.replace(/[^A-Za-z0-9_-]/g, "") || "en";
  const safeSiteNumber = siteNumber.replace(/[^A-Za-z0-9_-]/g, "") || "CX";
  const siteBaseUrl = `${parsed.protocol}//${parsed.host}`;
  const boardUrl = `${siteBaseUrl}/hcmUI/CandidateExperience/${safeLanguage}/sites/${safeSiteNumber}/jobs`;
  const apiUrl = `${siteBaseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
  const finder =
    `findReqs;siteNumber=${safeSiteNumber},` +
    `facetsList=${ORACLE_FACETS_VALUE},` +
    "limit=25,sortBy=POSTING_DATES_DESC";

  return {
    host,
    siteBaseUrl,
    boardUrl,
    apiUrl,
    siteNumber: safeSiteNumber,
    language: safeLanguage,
    finder
  };
}

function cleanOracleText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractOracleCompanyNameFromFacetList(facets) {
  if (!Array.isArray(facets)) return "";
  for (const facet of facets) {
    if (!facet || typeof facet !== "object") continue;
    const companyName = cleanOracleText(facet?.Name || facet?.name || "");
    if (companyName) return companyName;
  }
  return "";
}

function extractOracleCompanyNameFromItem(item) {
  if (!item || typeof item !== "object") return "";

  const direct = extractOracleCompanyNameFromFacetList(item.organizationsFacet);
  if (direct) return direct;

  const workLocationsFacet = Array.isArray(item.workLocationsFacet)
    ? item.workLocationsFacet
    : item.workLocationsFacet && typeof item.workLocationsFacet === "object"
      ? [item.workLocationsFacet]
      : [];
  for (const workLocation of workLocationsFacet) {
    if (!workLocation || typeof workLocation !== "object") continue;
    const nested = extractOracleCompanyNameFromFacetList(workLocation.organizationsFacet);
    if (nested) return nested;
  }

  return "";
}

function extractOracleCompanyNameFromResponse(responseJson) {
  const items = Array.isArray(responseJson?.items) ? responseJson.items : [];
  for (const item of items) {
    const companyName = extractOracleCompanyNameFromItem(item);
    if (companyName) return companyName;
  }
  return "";
}

function extractOracleLocationFromRequisition(item) {
  const requisition = item && typeof item === "object" ? item : {};
  const primaryLocation = cleanOracleText(requisition?.PrimaryLocation || requisition?.primaryLocation || "");
  if (primaryLocation) return primaryLocation;

  const workLocations = Array.isArray(requisition?.workLocation) ? requisition.workLocation : [];
  const values = [];
  const seen = new Set();

  for (const workLocation of workLocations) {
    const location = workLocation && typeof workLocation === "object" ? workLocation : {};
    const city = cleanOracleText(location?.TownOrCity || location?.townOrCity || "");
    const state = cleanOracleText(location?.Region2 || location?.region2 || "");
    const country = cleanOracleText(location?.Country || location?.country || "");
    const locationName = cleanOracleText(location?.LocationName || location?.locationName || "");
    const label = [city, state, country].filter(Boolean).join(", ") || locationName;
    const normalized = String(label || "").toLowerCase();
    if (!label || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(label);
  }

  return values.length > 0 ? values.join(" / ") : null;
}

function buildOraclePostingUrl(config, requisitionId) {
  const id = String(requisitionId || "").trim();
  if (!id) return String(config?.boardUrl || "").trim();
  return (
    `${config.siteBaseUrl}/hcmUI/CandidateExperience/${encodeURIComponent(config.language)}` +
    `/sites/${encodeURIComponent(config.siteNumber)}/job/${encodeURIComponent(id)}`
  );
}

function parseOraclePostingsFromApi(companyNameForPostings, config, responseJson) {
  const items = Array.isArray(responseJson?.items) ? responseJson.items : [];
  const inferredCompanyName = extractOracleCompanyNameFromResponse(responseJson);
  const effectiveCompanyName =
    cleanOracleText(companyNameForPostings) ||
    inferredCompanyName ||
    `oracle_${String(config?.siteNumber || "cx").toLowerCase()}`;

  const postings = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  for (const item of items) {
    const container = item && typeof item === "object" ? item : {};
    const requisitions = Array.isArray(container?.requisitionList) ? container.requisitionList : [];

    for (const requisition of requisitions) {
      const row = requisition && typeof requisition === "object" ? requisition : {};
      const requisitionId = cleanOracleText(row?.Id || row?.id || "");
      if (requisitionId && seenIds.has(requisitionId)) continue;

      const postingDate = cleanOracleText(row?.PostedDate || row?.postDate || "");
      if (!postingDate) continue;

      const postingUrl = buildOraclePostingUrl(config, requisitionId);
      if (!postingUrl || seenUrls.has(postingUrl)) continue;

      const departmentValues = [
        cleanOracleText(row?.Department || row?.department || ""),
        cleanOracleText(row?.JobFamily || row?.jobFamily || ""),
        cleanOracleText(row?.Organization || row?.organization || ""),
        cleanOracleText(row?.BusinessUnit || row?.businessUnit || "")
      ].filter(Boolean);
      const uniqueDepartments = Array.from(new Set(departmentValues.map((value) => value.toLowerCase()))).map(
        (lowered) => departmentValues.find((value) => value.toLowerCase() === lowered) || lowered
      );

      const employmentTypeValues = [
        cleanOracleText(row?.WorkerType || row?.workerType || ""),
        cleanOracleText(row?.JobType || row?.jobType || ""),
        cleanOracleText(row?.ContractType || row?.contractType || ""),
        cleanOracleText(row?.WorkplaceType || row?.workplaceType || "")
      ].filter(Boolean);
      const uniqueEmploymentTypes = Array.from(
        new Set(employmentTypeValues.map((value) => value.toLowerCase()))
      ).map((lowered) => employmentTypeValues.find((value) => value.toLowerCase() === lowered) || lowered);

      postings.push({
        company_name: effectiveCompanyName,
        position_name: cleanOracleText(row?.Title || row?.title || "") || "Untitled Position",
        job_posting_url: postingUrl,
        posting_date: postingDate,
        location: extractOracleLocationFromRequisition(row),
        department: uniqueDepartments.length > 0 ? uniqueDepartments.join(" / ") : null,
        employment_type: uniqueEmploymentTypes.length > 0 ? uniqueEmploymentTypes.join(" / ") : null
      });

      seenUrls.add(postingUrl);
      if (requisitionId) seenIds.add(requisitionId);
    }
  }

  return postings;
}

async function fetchOracleJobRequisitionsPage(config, offset = 0, limit = 25) {
  const safeOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0;
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 25;
  const finder = String(config?.finder || "").replace(/limit=\d+/i, `limit=${safeLimit}`);
  const url = new URL(String(config?.apiUrl || "").trim());
  url.searchParams.set("onlyData", "true");
  url.searchParams.set("expand", ORACLE_EXPAND_VALUE);
  if (finder) {
    url.searchParams.set("finder", finder);
  }
  url.searchParams.set("offset", String(safeOffset));
  url.searchParams.set("limit", String(safeLimit));

  const res = await fetchWithAtsRateLimit("oracle", ORACLE_RATE_LIMIT_WAIT_MS, url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Oracle job requisitions request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || url.toString()).trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".oraclecloud.com")) {
    throw new Error(`Oracle API URL redirected to unexpected host: ${finalUrl}`);
  }

  return res.json();
}

module.exports = { collectPostingsForOracleCompany, parseOracleCompany };