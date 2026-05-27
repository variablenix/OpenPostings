const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const MAX_PAGES_PER_COMPANY = 25;

const RIPPLING_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForRipplingCompany(company) {
  const config = parseRipplingCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySlug;
  const pageSize = 100;
  const seenUrls = new Set();
  const collected = [];

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const responseJson = await fetchRipplingJobsPage(config, page, pageSize);
    const batch = parseRipplingPostingsFromApi(companyNameForPostings, config, responseJson);

    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    const totalPagesRaw = Number(responseJson?.totalPages);
    const totalPages = Number.isFinite(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : 1;
    if (page + 1 >= totalPages) break;
    if (batch.length < pageSize) break;
  }

  return collected;
}

function parseRipplingCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "ats.rippling.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  let companySlug = "";
  if (pathParts.length > 0) {
    if (String(pathParts[0] || "").toLowerCase() === "api" && pathParts.length >= 5) {
      companySlug = String(pathParts[4] || "").trim();
    } else {
      companySlug = String(pathParts[0] || "").trim();
    }
  }

  if (!companySlug) return null;

  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    boardUrl: `https://ats.rippling.com/${companySlug}/jobs`,
    apiUrl: `https://ats.rippling.com/api/v2/board/${companySlug}/jobs`
  };
}


function formatRipplingLocation(locationsValue) {
  const locations = Array.isArray(locationsValue) ? locationsValue : [];
  const values = [];
  const seen = new Set();

  for (const location of locations) {
    const item = location && typeof location === "object" ? location : {};
    const name = String(item?.name || "").trim();
    const city = String(item?.city || "").trim();
    const state = String(item?.state || item?.stateCode || "").trim();
    const country = String(item?.country || "").trim();
    const fallback = [city, state, country].filter(Boolean).join(", ");
    const label = name || fallback;
    const normalized = label.toLowerCase();
    if (!label || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(label);
  }

  return values.length > 0 ? values.join(" / ") : null;
}

function parseRipplingPostingsFromApi(companyNameForPostings, config, responseJson) {
  const items = Array.isArray(responseJson?.items) ? responseJson.items : [];
  const postings = [];
  const seenUrls = new Set();

  for (const row of items) {
    const item = row && typeof row === "object" ? row : {};
    const postingId = String(item?.id || "").trim();
    const itemUrlRaw = String(item?.url || "").trim();
    const jobUrl = itemUrlRaw || (postingId ? `${config.boardUrl}/${postingId}` : "");
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const postingDate =
      String(item?.postedAt || item?.createdAt || item?.updatedAt || item?.publishedAt || "").trim() || null;
    const department = String(item?.department?.name || "").trim() || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.name || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: formatRipplingLocation(item?.locations),
      department,
      employment_type: String(item?.employmentType || item?.employment_type || "").trim() || null,
      workplace_type: String(item?.workplaceType || item?.workplace_type || "").trim() || null,
      language: String(item?.language || "").trim() || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}


async function fetchRipplingJobsPage(config, page = 0, pageSize = 100) {
  const res = await fetchWithAtsRateLimit("rippling", RIPPLING_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rippling API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  // Primary board API currently returns the first page without requiring params,
  // but we still keep page/pageSize inputs for future compatibility.
  const responseJson = await res.json();
  if (page > 0 || pageSize !== 100) {
    const pagedRes = await fetchWithAtsRateLimit(
      "rippling",
      RIPPLING_RATE_LIMIT_WAIT_MS,
      `${config.apiUrl}?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*"
        }
      }
    );
    if (!pagedRes.ok) {
      return responseJson;
    }
    return pagedRes.json();
  }

  return responseJson;
}

module.exports = { collectPostingsForRipplingCompany, parseRipplingCompany };
