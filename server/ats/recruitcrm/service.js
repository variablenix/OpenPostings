
const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const RECRUITCRM_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

async function collectPostingsForRecruitCrmCompany(company) {
  const config = parseRecruitCrmCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.account;
  const limit = 100;
  const seenUrls = new Set();
  const collected = [];

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const offset = page * limit;
    const responseJson = await fetchRecruitCrmJobsPage(config, limit, offset);
    const batch = parseRecruitCrmPostingsFromApi(companyNameForPostings, config, responseJson);

    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    if (batch.length < limit) break;
  }

  return collected;
}


function parseRecruitCrmCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "recruitcrm.io" && !host.endsWith(".recruitcrm.io")) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  let account = "";
  if (pathParts.length >= 2 && String(pathParts[0] || "").toLowerCase() === "jobs") {
    account = String(pathParts[1] || "").trim();
  } else {
    const queryAccount = String(parsed.searchParams?.get("account") || "").trim();
    account = queryAccount;
  }

  if (!account) return null;

  return {
    host,
    account,
    accountLower: account.toLowerCase(),
    publicJobsUrl: `https://recruitcrm.io/jobs/${encodeURIComponent(account)}`,
    apiUrl:
      `https://albatross.recruitcrm.io/v1/external-pages/jobs-by-account/get?account=${encodeURIComponent(account)}&batch=true`
  };
}


function formatRecruitCrmLocation(item) {
  const city = String(item?.city || "").trim();
  const locality = String(item?.locality || "").trim();
  const postalCode = String(item?.postalcode || "").trim();
  const parts = [city, locality, postalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseRecruitCrmPostingsFromApi(companyNameForPostings, config, responseJson) {
  const data = responseJson?.data;
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const postings = [];
  const seenUrls = new Set();

  for (const row of jobs) {
    const item = row && typeof row === "object" ? row : {};
    const slug = String(item?.slug || "").trim();
    const itemUrlRaw = String(item?.url || "").trim();
    const itemUrl = itemUrlRaw || (slug ? `${config.publicJobsUrl}/${slug}` : "");
    if (!itemUrl || seenUrls.has(itemUrl)) continue;

    const postingDate =
      String(
        item?.posted_at ||
          item?.published_at ||
          item?.created_at ||
          item?.updated_at ||
          item?.createdon ||
          item?.updatedon ||
          ""
      ).trim() || null;
    const isRemote = String(item?.remote || "").trim() === "1";

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.name || "").trim() || "Untitled Position",
      job_posting_url: itemUrl,
      posting_date: postingDate,
      location: isRemote ? "Remote" : formatRecruitCrmLocation(item),
      employment_type: String(item?.employment_type || "").trim() || null,
      department: String(item?.department || "").trim() || null
    });
    seenUrls.add(itemUrl);
  }

  return postings;
}


async function fetchRecruitCrmJobsPage(config, limit = 100, offset = 0) {
  const payload = {
    limit,
    offset,
    search_data: "",
    onlyJobs: true
  };
  const res = await fetchWithAtsRateLimit("recruitcrm", RECRUITCRM_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://recruitcrm.io",
      Referer: config.publicJobsUrl,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RecruitCRM API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}


module.exports = { collectPostingsForRecruitCrmCompany, parseRecruitCrmCompany };