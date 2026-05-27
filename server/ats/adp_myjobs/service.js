const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const ADP_MYJOBS_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

async function fetchAdpMyjobsJobsPage(config, careerSiteJson, top = 100, skip = 0) {
  const myJobsToken = String(careerSiteJson?.myJobsToken || "").trim();
  const myadpUrl = String(careerSiteJson?.properties?.myadpUrl || "").trim().replace(/\/+$/, "");
  if (!myJobsToken || !myadpUrl) {
    return { count: 0, jobRequisitions: [] };
  }

  const params = new URLSearchParams({
    $select:
      "reqId,jobTitle,publishedJobTitle,type,jobDescription,jobQualifications,workLocations,workLevelCode,clientRequisitionID,postingDate,requisitionLocations,postingLocations,organizationalUnits",
    $top: String(Math.max(1, Number(top || 100))),
    $skip: String(Math.max(0, Number(skip || 0))),
    $filter: "",
    radius: "25",
    tz: "America/Los_Angeles"
  }).toString();
  const apiUrl = `${myadpUrl}/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/apply-custom-filters?${params}`;

  const res = await fetchWithAtsRateLimit("adp_myjobs", ADP_MYJOBS_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      myjobstoken: myJobsToken,
      rolecode: "manager",
      Origin: "https://myjobs.adp.com",
      Referer: config.boardUrl
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADP MyJobs jobs request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

async function fetchAdpMyjobsCareerSite(config) {
  const res = await fetchWithAtsRateLimit("adp_myjobs", ADP_MYJOBS_RATE_LIMIT_WAIT_MS, config.careerSiteUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADP MyJobs career-site request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

function parseAdpMyjobsCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "myjobs.adp.com" && host !== "www.myjobs.adp.com") return null;

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
    boardUrl: `https://myjobs.adp.com/${companyName}/cx/job-listing`,
    careerSiteUrl: `https://myjobs.adp.com/public/staffing/v1/career-site/${encodeURIComponent(companyName)}`
  };
}

function extractAdpMyjobsLocationParts(locationItem) {
  const item = locationItem && typeof locationItem === "object" ? locationItem : {};
  const nameCode = item?.nameCode && typeof item.nameCode === "object" ? item.nameCode : {};
  const locationName = String(nameCode?.longName || "").trim();
  const address = item?.address && typeof item.address === "object" ? item.address : {};
  const city = String(address?.cityName || "").trim();
  const stateData =
    address?.countrySubdivisionLevel1 && typeof address.countrySubdivisionLevel1 === "object"
      ? address.countrySubdivisionLevel1
      : {};
  const state = String(stateData?.codeValue || stateData?.longName || "").trim();
  const countryData = address?.country && typeof address.country === "object" ? address.country : {};
  const country = String(countryData?.longName || countryData?.codeValue || "").trim();
  const addressValue = [city, state, country].filter(Boolean).join(", ");
  return {
    locationName,
    addressValue
  };
}


function formatAdpMyjobsLocation(job) {
  const item = job && typeof job === "object" ? job : {};
  const values = [];
  const seen = new Set();

  for (const field of ["requisitionLocations", "workLocations", "postingLocations"]) {
    const locations = Array.isArray(item?.[field]) ? item[field] : [];
    for (const locationItem of locations) {
      const { locationName, addressValue } = extractAdpMyjobsLocationParts(locationItem);
      const label = locationName && addressValue ? `${locationName} - ${addressValue}` : locationName || addressValue;
      const normalized = String(label || "").trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(String(label || "").trim());
    }
  }

  return values.length > 0 ? values.join(" / ") : null;
}

function parseAdpMyjobsPostingsFromApi(companyNameForPostings, config, responseJson) {
  const jobs = Array.isArray(responseJson?.jobRequisitions) ? responseJson.jobRequisitions : [];
  const postings = [];
  const seenUrls = new Set();
  const seenIds = new Set();

  for (const row of jobs) {
    const item = row && typeof row === "object" ? row : {};
    const reqId = String(item?.reqId || "").trim();
    if (reqId && seenIds.has(reqId)) continue;

    const itemUrlRaw = String(item?.url || item?.jobUrl || "").trim();
    const jobUrl = itemUrlRaw || (reqId ? `https://myjobs.adp.com/${config.companyName}/cx/job-details?reqId=${encodeURIComponent(reqId)}` : "");
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const postingDate = String(item?.postingDate || "").trim() || null;
    const departmentValues = Array.isArray(item?.organizationalUnits)
      ? item.organizationalUnits
          .map((unit) => String(unit?.nameCode?.longName || unit?.name || "").trim())
          .filter(Boolean)
      : [];

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.publishedJobTitle || item?.jobTitle || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: formatAdpMyjobsLocation(item),
      department: departmentValues.length > 0 ? departmentValues.join(" / ") : null,
      employment_type: String(item?.type || "").trim() || null
    });
    seenUrls.add(jobUrl);
    if (reqId) {
      seenIds.add(reqId);
    }
  }

  return postings;
}

async function collectPostingsForAdpMyjobsCompany(company) {
  const config = parseAdpMyjobsCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyNameLower;
  const careerSiteJson = await fetchAdpMyjobsCareerSite(config);
  const pageSize = 100;
  const seenUrls = new Set();
  const collected = [];

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const skip = page * pageSize;
    const responseJson = await fetchAdpMyjobsJobsPage(config, careerSiteJson, pageSize, skip);
    const batch = parseAdpMyjobsPostingsFromApi(companyNameForPostings, config, responseJson);

    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    const totalCount = Number(responseJson?.count);
    if (batch.length < pageSize) break;
    if (Number.isFinite(totalCount) && totalCount >= 0 && skip + pageSize >= totalCount) break;
  }

  return collected;
}

module.exports = { collectPostingsForAdpMyjobsCompany, parseAdpMyjobsCompany };