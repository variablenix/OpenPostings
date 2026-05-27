const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const MAX_PAGES_PER_COMPANY = 25;

const TALEXIO_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForTalexioCompany(company) {
  const config = parseTalexioCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;

  const collected = [];
  const seenUrls = new Set();
  const pageSize = 10;
  let totalVacancies = null;

  for (let page = 1; page <= MAX_PAGES_PER_COMPANY; page += 1) {
    const responseJson = await fetchTalexioJobsPage(config, page, pageSize);
    const batch = parseTalexioPostingsFromApi(companyNameForPostings, config, responseJson);
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    const vacancies = Array.isArray(responseJson?.vacancies) ? responseJson.vacancies : [];
    const totalRaw = Number(responseJson?.totalVacancies);
    if (Number.isFinite(totalRaw) && totalRaw >= 0) {
      totalVacancies = totalRaw;
    }

    if (vacancies.length < pageSize) break;
    if (Number.isFinite(totalVacancies) && collected.length >= Number(totalVacancies)) break;
  }

  return collected;
}

function parseTalexioCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".talexio.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length > 0 && String(pathParts[0] || "").toLowerCase() !== "jobs") return null;

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin,
    jobsUrl: `${baseOrigin}/jobs/`,
    apiUrl: `${baseOrigin}/api/jobs`
  };
}

function parseTalexioPostingsFromApi(companyNameForPostings, config, responseJson) {
  const vacancies = Array.isArray(responseJson?.vacancies) ? responseJson.vacancies : [];
  const postings = [];
  const seenUrls = new Set();

  for (const vacancy of vacancies) {
    const item = vacancy && typeof vacancy === "object" ? vacancy : {};
    const vacancyId = String(item?.id || "").trim();
    const itemUrlRaw = String(item?.url || item?.jobUrl || item?.vacancyUrl || item?.applyUrl || "").trim();
    const itemUrl = itemUrlRaw
      ? new URL(itemUrlRaw, `${config.baseOrigin || config.jobsUrl || ""}/`).toString()
      : vacancyId
        ? `${config.jobsUrl}?vacancyId=${encodeURIComponent(vacancyId)}`
        : "";
    if (!itemUrl || seenUrls.has(itemUrl)) continue;

    const workLocation = String(item?.workLocation || "").trim();
    const country = String(item?.country || "").trim();
    const location = [workLocation, country].filter(Boolean).join(", ");
    const postingDate = String(item?.publishDate || "").trim() || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.title || "").trim() || "Untitled Position",
      job_posting_url: itemUrl,
      posting_date: postingDate,
      location: location || null,
      reference: String(item?.reference || "").trim() || null,
      department: String(item?.department || "").trim() || null,
      employment_type: String(item?.jobType || "").trim() || null
    });
    seenUrls.add(itemUrl);
  }

  return postings;
}

async function fetchTalexioJobsPage(config, page = 1, limit = 10) {
  const apiUrl = String(config?.apiUrl || "").trim();
  if (!apiUrl) {
    throw new Error("Talexio API URL is missing");
  }

  const url = `${apiUrl}?${new URLSearchParams({
    search: "",
    sortBy: "relevance",
    page: String(page),
    limit: String(limit)
  }).toString()}`;

  const res = await fetchWithAtsRateLimit("talexio", TALEXIO_RATE_LIMIT_WAIT_MS, url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Talexio API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

module.exports = { collectPostingsForTalexioCompany, parseTalexioCompany };
