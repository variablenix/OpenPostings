const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const CAREERPUCK_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function fetchCareerpuckJobBoard(config) {
  const res = await fetchWithAtsRateLimit("careerpuck", CAREERPUCK_RATE_LIMIT_WAIT_MS, config.apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CareerPuck API request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}


function parseCareerpuckCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "app.careerpuck.com" && host !== "www.app.careerpuck.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length < 2 || pathParts[0].toLowerCase() !== "job-board") return null;

  const boardSlug = String(pathParts[1] || "").trim();
  if (!boardSlug) return null;

  return {
    host,
    boardSlug,
    boardSlugLower: boardSlug.toLowerCase(),
    boardUrl: `${parsed.protocol}//${parsed.host}/job-board/${boardSlug}`,
    apiUrl: `https://api.careerpuck.com/v1/public/job-boards/${encodeURIComponent(boardSlug)}`
  };
}

async function collectPostingsForCareerpuckCompany(company) {
  const config = parseCareerpuckCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.boardSlugLower;
  const responseJson = await fetchCareerpuckJobBoard(config);
  return parseCareerpuckPostingsFromApi(companyNameForPostings, responseJson);
}


function parseCareerpuckPostingsFromApi(companyNameForPostings, responseJson) {
  const jobs = Array.isArray(responseJson?.jobs) ? responseJson.jobs : [];
  const postings = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    const status = String(job?.status || "").trim().toLowerCase();
    if (status && status !== "public") continue;

    const publicUrl = String(job?.publicUrl || "").trim();
    const applyUrl = String(job?.applyUrl || "").trim();
    const jobUrl = publicUrl || applyUrl;
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const title = String(job?.title || "").trim() || "Untitled Position";
    const location = String(job?.location || "").trim() || null;
    const postingDate = String(job?.postedAt || "").trim() || null;
    const departmentNames = Array.isArray(job?.departments)
      ? job.departments
          .map((item) => String(item?.name || "").trim())
          .filter(Boolean)
      : [];

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location,
      department: departmentNames.length > 0 ? departmentNames.join(" / ") : null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

module.exports = { collectPostingsForCareerpuckCompany, parseCareerpuckCompany };