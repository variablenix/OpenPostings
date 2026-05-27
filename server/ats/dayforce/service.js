const {
  parseUrl,
  decodeHtmlEntities,
  stripHtml,
  toCleanString,
  DEFAULT_BROWSER_USER_AGENT
} = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const DAYFORCE_RATE_LIMIT_WAIT_MS = 60 * 1000;

function cleanDayforceText(value) {
  return decodeHtmlEntities(stripHtml(String(value || "")))
    .replace(/\s+/g, " ")
    .trim();
}

function parseDayforceCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".dayforcehcm.com") && host !== "dayforcehcm.com") return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  let cultureCode = "";
  let clientNamespace = "";
  let jobBoardCode = "";

  if (String(pathParts[0] || "").toLowerCase() === "candidateportal") {
    if (pathParts.length >= 4 && /^[a-z]{2}-[a-z]{2}$/i.test(pathParts[1])) {
      cultureCode = pathParts[1];
      clientNamespace = pathParts[2];
      if (String(pathParts[3] || "").toLowerCase() === "site") {
        jobBoardCode = pathParts[4] || "";
      } else {
        jobBoardCode = pathParts[3] || "";
      }
    } else if (pathParts.length >= 3) {
      clientNamespace = pathParts[1];
      jobBoardCode = pathParts[2];
    }
  } else {
    if (pathParts.length >= 3 && /^[a-z]{2}-[a-z]{2}$/i.test(pathParts[0])) {
      cultureCode = pathParts[0];
      clientNamespace = pathParts[1];
      jobBoardCode = pathParts[2];
    } else if (pathParts.length >= 2) {
      clientNamespace = pathParts[0];
      jobBoardCode = pathParts[1];
    } else if (pathParts.length === 1) {
      clientNamespace = pathParts[0];
    }
  }

  clientNamespace = toCleanString(clientNamespace);
  if (!clientNamespace) return null;

  cultureCode = toCleanString(cultureCode) || "en-US";
  jobBoardCode = toCleanString(jobBoardCode) || "CANDIDATEPORTAL";

  const origin = `${parsed.protocol}//${parsed.host}`;
  const boardUrl = `${origin}/${cultureCode}/${clientNamespace}/${jobBoardCode}`;

  return {
    host,
    origin,
    boardUrl,
    cultureCode,
    clientNamespace,
    jobBoardCode
  };
}

function extractDayforceNextData(boardHtml) {
  const source = String(boardHtml || "");
  const match = source.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractDayforceSiteInfo(nextData) {
  const queries = Array.isArray(nextData?.props?.pageProps?.dehydratedState?.queries)
    ? nextData.props.pageProps.dehydratedState.queries
    : [];
  for (const query of queries) {
    const key = Array.isArray(query?.queryKey) ? query.queryKey[0] : "";
    if (String(key || "") !== "site-info") continue;
    const data = query?.state?.data;
    if (data?.result && typeof data.result === "object") return data.result;
    if (data && typeof data === "object") return data;
  }
  return null;
}

function normalizeDayforcePostingDate(value) {
  const raw = cleanDayforceText(value || "");
  if (!raw) return null;

  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const epochMs = numeric >= 1e12 ? numeric : numeric * 1000;
      const asDate = new Date(epochMs);
      if (!Number.isNaN(asDate.getTime())) {
        return asDate.toISOString();
      }
    }
  }

  const parsedMs = Date.parse(raw);
  if (Number.isFinite(parsedMs)) {
    return new Date(parsedMs).toISOString();
  }

  return null;
}

function getDayforceFirstValue(item, candidates) {
  for (const candidate of candidates) {
    const value = candidate(item);
    const normalized = cleanDayforceText(value);
    if (normalized) return normalized;
  }
  return "";
}

function extractDayforceLocation(item) {
  const direct = getDayforceFirstValue(item, [
    (source) => source?.location,
    (source) => source?.locationName,
    (source) => source?.locationString,
    (source) => source?.postingLocation,
    (source) => source?.postingLocationName,
    (source) => source?.displayLocation,
    (source) => source?.jobLocation,
    (source) => source?.cityState,
    (source) => source?.city,
    (source) => source?.state,
    (source) => source?.country
  ]);
  if (direct) return direct;

  const arrayLocations = [
    ...(Array.isArray(item?.postingLocations) ? item.postingLocations : []),
    ...(Array.isArray(item?.locations) ? item.locations : [])
  ];
  if (arrayLocations.length > 0) {
    const joined = arrayLocations
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const parts = [
            entry.locationName,
            entry.addressLine1,
            entry.addressLine2,
            entry.city,
            entry.state,
            entry.province,
            entry.country,
            entry.postalCode
          ]
            .map((part) => cleanDayforceText(part))
            .filter(Boolean);
          return parts.join(", ");
        }
        return cleanDayforceText(entry);
      })
      .filter(Boolean)
      .join(" | ");
    if (joined) return joined;
  }

  const addressCandidates = [item?.locationAddress, item?.address, item?.jobLocationAddress].filter(
    (entry) => entry && typeof entry === "object"
  );
  for (const address of addressCandidates) {
    const parts = [
      address.addressLine1,
      address.addressLine2,
      address.city,
      address.state,
      address.province,
      address.country,
      address.postalCode
    ]
      .map((part) => cleanDayforceText(part))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(", ");
  }

  return null;
}

function buildDayforcePostingUrl(config, posting, postingId) {
  const directUrl = getDayforceFirstValue(posting, [
    (source) => source?.jobPostingUrl,
    (source) => source?.jobUrl,
    (source) => source?.applyUrl,
    (source) => source?.url
  ]);
  if (directUrl) {
    try {
      return new URL(directUrl, config.boardUrl).toString();
    } catch {
      return "";
    }
  }

  const idValue = cleanDayforceText(postingId);
  if (!idValue) return "";

  try {
    return new URL(`${config.cultureCode}/${config.clientNamespace}/${config.jobBoardCode}/jobs/${encodeURIComponent(idValue)}`, config.origin).toString();
  } catch {
    return "";
  }
}

function getDayforcePostingList(responseJson) {
  const source = responseJson && typeof responseJson === "object" ? responseJson : {};
  const candidates = [
    source?.jobPostings,
    source?.jobPostingSummaries,
    source?.searchResult?.jobPostings,
    source?.searchResult?.jobPostingSummaries,
    source?.result?.jobPostings,
    source?.result?.jobPostingSummaries,
    source?.data?.jobPostings,
    source?.data?.jobPostingSummaries,
    Array.isArray(source) ? source : null
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry) => entry && typeof entry === "object");
    }
  }
  return [];
}

function parseDayforcePostingsFromApi(companyNameForPostings, config, responseJson) {
  const rawPostings = getDayforcePostingList(responseJson);
  const postings = [];
  const seenUrls = new Set();

  for (const posting of rawPostings) {
    const postingId = getDayforceFirstValue(posting, [
      (source) => source?.jobPostingId,
      (source) => source?.postingId,
      (source) => source?.id,
      (source) => source?.externalJobPostingId,
      (source) => source?.externalJobId,
      (source) => source?.jobId,
      (source) => source?.reqId,
      (source) => source?.requisitionId
    ]);

    const postingUrl = buildDayforcePostingUrl(config, posting, postingId);
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const postingDate = normalizeDayforcePostingDate(
      posting?.postingStartTimestampUTC ||
        posting?.postingStartDateUTC ||
        posting?.postingDate ||
        posting?.postedDate ||
        posting?.createdDate ||
        posting?.publishDate ||
        posting?.publishDateUTC ||
        posting?.lastModifiedDate ||
        posting?.updatedDate
    );

    const positionName =
      getDayforceFirstValue(posting, [
        (source) => source?.jobTitle,
        (source) => source?.title,
        (source) => source?.postingTitle,
        (source) => source?.name,
        (source) => source?.requisitionTitle
      ]) || "Untitled Position";

    const jobDescription =
      getDayforceFirstValue(posting, [
        (source) => source?.jobDescription,
        (source) => source?.description,
        (source) => source?.fullDescription,
        (source) => source?.shortDescription,
        (source) => source?.overview
      ]) || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName,
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location: extractDayforceLocation(posting),
      job_description: jobDescription,
      department:
        getDayforceFirstValue(posting, [
          (source) => source?.department,
          (source) => source?.departmentName,
          (source) => source?.jobDepartment
        ]) || null,
      employment_type:
        getDayforceFirstValue(posting, [
          (source) => source?.employmentType,
          (source) => source?.payClass,
          (source) => source?.payClassName
        ]) || null,
      external_id:
        postingId ||
        getDayforceFirstValue(posting, [(source) => source?.externalJobPostingId, (source) => source?.externalJobId]) ||
        null
    });

    seenUrls.add(postingUrl);
  }

  return postings;
}

async function collectPostingsForDayforceCompany(company) {
  const config = parseDayforceCompany(company?.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();

  const boardRes = await fetchWithAtsRateLimit("dayforcehcm", DAYFORCE_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": DEFAULT_BROWSER_USER_AGENT
    }
  });

  if (!boardRes.ok) {
    const body = await boardRes.text();
    throw new Error(`Dayforce board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
  }

  const finalBoardUrl = String(boardRes.url || config.boardUrl || "").trim();
  const boardHtml = await boardRes.text();
  const runtimeConfig = parseDayforceCompany(finalBoardUrl) || config;
  const nextData = extractDayforceNextData(boardHtml);
  const siteInfo = extractDayforceSiteInfo(nextData);

  const clientNamespace =
    toCleanString(siteInfo?.clientNamespace) ||
    toCleanString(nextData?.query?.clientNamespace) ||
    runtimeConfig.clientNamespace;
  const jobBoardCode =
    toCleanString(siteInfo?.careerSiteXRefCode) ||
    toCleanString(nextData?.query?.careerSiteXRefCode) ||
    runtimeConfig.jobBoardCode;
  const cultureCode =
    toCleanString(siteInfo?.cultureCode) || toCleanString(nextData?.locale) || runtimeConfig.cultureCode || "en-US";

  if (!clientNamespace || !jobBoardCode) return [];

  const searchPayload = {
    clientNamespace,
    jobBoardCode,
    cultureCode,
    paginationStart: 0,
    distanceUnit: 0
  };

  const jobBoardId = Number(siteInfo?.jobBoardId || siteInfo?.jobBoard?.jobBoardId || 0);
  if (Number.isFinite(jobBoardId) && jobBoardId > 0) {
    searchPayload.jobBoardId = jobBoardId;
  }

  const searchUrl = `${runtimeConfig.origin}/api/geo/${encodeURIComponent(clientNamespace)}/jobposting/search`;
  const searchRes = await fetchWithAtsRateLimit("dayforcehcm", DAYFORCE_RATE_LIMIT_WAIT_MS, searchUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: runtimeConfig.origin,
      Referer: finalBoardUrl,
      "User-Agent": DEFAULT_BROWSER_USER_AGENT
    },
    body: JSON.stringify(searchPayload)
  });

  if (!searchRes.ok) {
    const body = await searchRes.text();
    throw new Error(`Dayforce search request failed (${searchRes.status}): ${body.slice(0, 180)}`);
  }

  const responseText = await searchRes.text();
  let responseJson = {};
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new Error(`Dayforce search response was not JSON: ${responseText.slice(0, 180)}`);
  }

  const companyNameForPostings = normalizedCompanyName || `dayforce_${clientNamespace}`;
  return parseDayforcePostingsFromApi(
    companyNameForPostings,
    {
      ...runtimeConfig,
      boardUrl: finalBoardUrl,
      cultureCode,
      clientNamespace,
      jobBoardCode
    },
    responseJson
  );
}

module.exports = { collectPostingsForDayforceCompany, parseDayforceCompany };
