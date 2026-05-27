
const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PINPOINTHQ_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForPinpointHqCompany(company) {
  const config = parsePinpointHqCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const responseJson = await fetchPinpointHqJobBoard(config);
  return parsePinpointHqPostingsFromApi(companyNameForPostings, config, responseJson);
}

function parsePinpointHqCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".pinpointhq.com")) return null;
  if (host === "pinpointhq.com" || host === "www.pinpointhq.com") return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin,
    boardUrl: `${baseOrigin}/`,
    apiUrl: `${baseOrigin}/postings.json`
  };
}


function formatPinpointHqLocation(locationValue) {
  const location = locationValue && typeof locationValue === "object" ? locationValue : {};
  const city = String(location?.city || "").trim();
  const province = String(location?.province || "").trim();
  const countryOrName = String(location?.name || "").trim();
  const parts = [city, province, countryOrName].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parsePinpointHqPostingsFromApi(companyNameForPostings, config, responseJson) {
  const data = Array.isArray(responseJson?.data) ? responseJson.data : [];
  const postings = [];
  const seenUrls = new Set();

  for (const row of data) {
    const item = row && typeof row === "object" ? row : {};
    const itemUrlRaw = String(item?.url || "").trim();
    const itemPathRaw = String(item?.path || "").trim();
    const jobUrl = itemUrlRaw
      ? itemUrlRaw
      : itemPathRaw
        ? new URL(itemPathRaw, `${config.baseOrigin || config.boardUrl || ""}/`).toString()
        : "";
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const postingDate =
      String(item?.posted_at || item?.published_at || item?.created_at || item?.updated_at || item?.deadline_at || "").trim() ||
      null;
    const department = String(item?.job?.department?.name || "").trim() || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.title || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: formatPinpointHqLocation(item?.location),
      department,
      employment_type: String(item?.employment_type_text || item?.employment_type || "").trim() || null,
      workplace_type: String(item?.workplace_type_text || item?.workplace_type || "").trim() || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}


async function fetchPinpointHqJobBoard(config) {
  const timestamp = Date.now().toString();
  const queryGlue = String(config.apiUrl || "").includes("?") ? "&" : "?";
  const requestUrl = `${config.apiUrl}${queryGlue}_=${encodeURIComponent(timestamp)}`;
  const res = await fetchWithAtsRateLimit("pinpointhq", PINPOINTHQ_RATE_LIMIT_WAIT_MS, requestUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PinpointHQ API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || requestUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".pinpointhq.com") || finalHost === "pinpointhq.com" || finalHost === "www.pinpointhq.com") {
    throw new Error(`PinpointHQ URL redirected to unexpected host: ${finalUrl}`);
  }

  return res.json();
}

module.exports = { collectPostingsForPinpointHqCompany, parsePinpointHqCompany };