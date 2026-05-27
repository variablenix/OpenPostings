const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const GETRO_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForGetroCompany(company) {
  const config = parseGetroCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const pageHtml = await fetchGetroJobsPage(config.jobsUrl);
  return parseGetroPostingsFromHtml(companyNameForPostings, config, pageHtml);
}

function parseGetroCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host === "www.getro.com") return null;
  if (!host.endsWith(".getro.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    origin: `${parsed.protocol}//${parsed.host}`,
    jobsUrl: `${parsed.protocol}//${parsed.host}/jobs`
  };
}

function buildGetroInternalJobUrl(config, jobItem) {
  const origin = String(config?.origin || "").trim();
  const organizationSlug = String(jobItem?.organization?.slug || "").trim();
  const jobSlug = String(jobItem?.slug || "").trim();
  if (!origin || !organizationSlug || !jobSlug) return "";

  const encodedOrganizationSlug = encodeURIComponent(organizationSlug);
  const encodedJobSlug = encodeURIComponent(jobSlug);
  return `${origin}/companies/${encodedOrganizationSlug}/jobs/${encodedJobSlug}`;
}


function extractGetroNextDataJsonFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const match = source.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/i
  );
  if (!match?.[1]) return {};
  try {
    return JSON.parse(String(match[1] || "").trim());
  } catch {
    return {};
  }
}

function parseGetroPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const nextData = extractGetroNextDataJsonFromHtml(pageHtml);
  const pageProps = nextData?.props?.pageProps && typeof nextData.props.pageProps === "object"
    ? nextData.props.pageProps
    : {};
  const initialState = pageProps?.initialState && typeof pageProps.initialState === "object"
    ? pageProps.initialState
    : {};
  const jobsState = initialState?.jobs && typeof initialState.jobs === "object"
    ? initialState.jobs
    : {};
  const foundJobs = Array.isArray(jobsState?.found) ? jobsState.found : [];

  const postings = [];
  const seenUrls = new Set();

  for (const job of foundJobs) {
    const item = job && typeof job === "object" ? job : {};
    const jobUrl =
      buildGetroInternalJobUrl(config, item) ||
      String(item?.url || "").trim();
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const searchableLocations = Array.isArray(item?.searchableLocations) ? item.searchableLocations : [];
    const locations = Array.isArray(item?.locations) ? item.locations : [];
    const locationValue = String(searchableLocations[0] || locations[0] || "").trim();

    const createdAtRaw = item?.createdAt;
    let postingDate = null;
    if (Number.isFinite(Number(createdAtRaw)) && Number(createdAtRaw) > 0) {
      postingDate = String(Math.floor(Number(createdAtRaw)));
    } else if (typeof createdAtRaw === "string" && createdAtRaw.trim()) {
      postingDate = createdAtRaw.trim();
    }

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.title || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: locationValue || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

async function fetchGetroJobsPage(urlString) {
  const res = await fetchWithAtsRateLimit("getro", GETRO_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Getro page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

module.exports = { collectPostingsForGetroCompany, parseGetroCompany };
