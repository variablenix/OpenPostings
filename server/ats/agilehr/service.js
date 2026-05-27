const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

function parseAgilehrCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".agilehr.com") || host === "agilehr.com") return null;
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  return {
    host,
    apiUrl: `${baseOrigin}/public/api/careerportal/getall?sourceId=0`
  };
}

function isValidAgilehrDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return false;
  const parsedDate = new Date(parsedMs);
  return parsedDate.getUTCFullYear() > 1901;
}

function resolveAgilehrPostingDate(item) {
  const startDate = String(item?.StartDate || "").trim();
  if (isValidAgilehrDate(startDate)) return startDate;

  const openDate = String(item?.OpenDate || "").trim();
  if (isValidAgilehrDate(openDate)) return openDate;

  return null;
}

function parseAgilehrPostingsFromApi(companyNameForPostings, payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const resultList = Array.isArray(source?.ResultList) ? source.ResultList : null;
  let items = [];
  if (resultList) {
    items = resultList.filter((item) => item && typeof item === "object");
  } else if (source?.Result && typeof source.Result === "object" && !Array.isArray(source.Result)) {
    items = [source.Result];
  } else if (Array.isArray(source?.Result)) {
    items = source.Result.filter((item) => item && typeof item === "object");
  }

  const postings = [];
  const seenUrls = new Set();
  for (const item of items) {
    const postingUrl = String(item?.ApplyUrl || "").trim();
    if (!postingUrl || seenUrls.has(postingUrl)) continue;
    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.Title || "").trim() || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: resolveAgilehrPostingDate(item),
      location: String(item?.Location || item?.City || "").trim() || null
    });
    seenUrls.add(postingUrl);
  }
  return postings;
}

async function collectPostingsForAgilehrCompany(company) {
  const config = parseAgilehrCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "agilehr";

  const res = await fetchWithAtsRateLimit("agilehr", 60 * 1000, config.apiUrl, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgileHR request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  const payload = await res.json();
  return parseAgilehrPostingsFromApi(companyNameForPostings, payload);
}

module.exports = { collectPostingsForAgilehrCompany, parseAgilehrCompany };
