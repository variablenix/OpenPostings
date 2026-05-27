const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const BAMBOOHR_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parseBambooHrCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  const suffix = ".bamboohr.com";
  if (!host.endsWith(suffix)) return null;

  const companySubdomain = String(host.slice(0, -suffix.length) || "").trim();
  if (!companySubdomain || companySubdomain.includes(".") || companySubdomain === "www") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length > 0 && String(pathParts[0] || "").toLowerCase() !== "careers") return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    companySubdomain,
    companySubdomainLower: companySubdomain.toLowerCase(),
    baseOrigin,
    boardUrl: `${baseOrigin}/careers`,
    apiUrl: `${baseOrigin}/careers/list`
  };
}


function parseBambooHrPostingsFromApi(companyNameForPostings, config, responseJson) {
  const result = Array.isArray(responseJson?.result) ? responseJson.result : [];
  const postings = [];
  const seenUrls = new Set();

  for (const row of result) {
    const item = row && typeof row === "object" ? row : {};
    const postingId = String(item?.id || "").trim();
    const itemUrlRaw = String(item?.url || item?.jobUrl || item?.applyUrl || "").trim();
    const jobUrl = itemUrlRaw
      ? new URL(itemUrlRaw, `${config.baseOrigin || config.boardUrl || ""}/`).toString()
      : postingId
        ? `${config.boardUrl}/${encodeURIComponent(postingId)}`
        : config.boardUrl;
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const locationObject = item?.location && typeof item.location === "object" ? item.location : {};
    const atsLocationObject = item?.atsLocation && typeof item.atsLocation === "object" ? item.atsLocation : {};
    const city = String(locationObject?.city || atsLocationObject?.city || "").trim();
    const state = String(locationObject?.state || atsLocationObject?.state || atsLocationObject?.province || "").trim();
    const country = String(atsLocationObject?.country || "").trim();
    const cityState = [city, state].filter(Boolean).join(", ");
    const location = cityState || [city, country].filter(Boolean).join(", ") || (item?.isRemote ? "Remote" : null);

    const postingDate =
      String(item?.postingDate || item?.postedDate || item?.publishDate || item?.createdDate || item?.updatedDate || "").trim() ||
      null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.jobOpeningName || item?.title || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location,
      department: String(item?.departmentLabel || item?.department || "").trim() || null,
      employment_type: String(item?.employmentStatusLabel || item?.employmentStatus || "").trim() || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}


async function fetchBambooHrJobBoard(config) {
  const res = await fetchWithAtsRateLimit("bamboohr", BAMBOOHR_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BambooHR API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.apiUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".bamboohr.com") || finalHost === "bamboohr.com" || finalHost === "www.bamboohr.com") {
    throw new Error(`BambooHR URL redirected to unexpected host: ${finalUrl}`);
  }

  return res.json();
}


async function collectPostingsForBambooHrCompany(company) {
  const config = parseBambooHrCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySubdomainLower;
  const responseJson = await fetchBambooHrJobBoard(config);
  return parseBambooHrPostingsFromApi(companyNameForPostings, config, responseJson);
}

module.exports = { collectPostingsForBambooHrCompany, parseBambooHrCompany };