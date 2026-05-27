const { normalizeSourceUrlString, toCleanString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const OCCUPOP_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseOccupopCompany(url) {
  const normalizedUrl = normalizeSourceUrlString(url);
  if (!normalizedUrl) return null;
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".occupop-careers.com")) return null;
  let companyKey = host.split(".", 1)[0] || "";
  if (companyKey.startsWith("contextmenu-")) {
    companyKey = companyKey.slice("contextmenu-".length);
  }
  if (companyKey.startsWith("3a")) {
    companyKey = companyKey.slice(2);
  }
  companyKey = companyKey.replace(/^-+|-+$/g, "");
  if (!companyKey) return null;
  return {
    normalizedUrl,
    host,
    companyKey
  };
}

async function fetchOccupopLiveJobs(companyKey) {
  const query =
    "query LiveJobs($companyKey: String!, $tags: [String!], $includeAllBrandsJobs: Boolean) {\n" +
    "  careersPage {\n" +
    "    liveJobs(\n" +
    "      companyKey: $companyKey\n" +
    "      tags: $tags\n" +
    "      includeAllBrandsJobs: $includeAllBrandsJobs\n" +
    "    ) {\n" +
    "      __typename\n" +
    "      uuid\n" +
    "      title\n" +
    "      publishedAt\n" +
    "      companyName\n" +
    "      location {\n" +
    "        city\n" +
    "        country\n" +
    "        __typename\n" +
    "      }\n" +
    "      period\n" +
    "    }\n" +
    "    __typename\n" +
    "  }\n" +
    "}";

  const body = {
    operationName: "LiveJobs",
    variables: {
      companyKey,
      tags: []
    },
    query
  };

  const res = await fetchWithAtsRateLimit(
    "occupop",
    OCCUPOP_RATE_LIMIT_WAIT_MS,
    "https://gateway.server.occupop.com/graphql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        Origin: "https://www.occupop.com",
        Referer: "https://www.occupop.com/"
      },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) return [];
  let payload;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  const liveJobs = payload?.data?.careersPage?.liveJobs;
  return Array.isArray(liveJobs) ? liveJobs : [];
}

async function collectPostingsForOccupopCompany(company) {
  const config = parseOccupopCompany(company.url_string);
  if (!config) return [];

  const jobs = await fetchOccupopLiveJobs(config.companyKey);
  const results = [];
  const seen = new Set();
  for (const job of jobs) {
    const id = toCleanString(job?.uuid);
    if (!id) continue;
    const jobPostingUrl = `https://${config.host}/job/${id}`;
    if (!jobPostingUrl || seen.has(jobPostingUrl)) continue;
    const city = toCleanString(job?.location?.city);
    const country = toCleanString(job?.location?.country);
    const locationParts = [city, country].filter(Boolean);
    const location = locationParts.length > 0 ? locationParts.join(", ") : "";
    results.push({
      company_name: toCleanString(job?.companyName) || toCleanString(company.company_name) || config.companyKey,
      position_name: toCleanString(job?.title) || "Untitled Position",
      location,
      posting_date: toCleanString(job?.publishedAt),
      job_posting_url: jobPostingUrl
    });
    seen.add(jobPostingUrl);
  }
  return results;
}

module.exports = { collectPostingsForOccupopCompany, parseOccupopCompany };