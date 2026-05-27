const { parseUrl, stripHtml, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const JIBEAPPLY_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

function parseJibeapplyCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".jibeapply.com")) return null;
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  return {
    host,
    baseOrigin,
    apiUrl: `${baseOrigin}/api/jobs`
  };
}

function extractJibeapplyJobs(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === "object");
  }
  if (!payload || typeof payload !== "object") return [];

  for (const key of ["jobs", "results", "items", "data"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter((item) => item && typeof item === "object");
    }
    if (value && typeof value === "object" && Array.isArray(value.jobs)) {
      return value.jobs.filter((item) => item && typeof item === "object");
    }
  }
  return [];
}

function toJibeapplyText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return stripHtml(decodeHtmlEntities(raw));
}

function pickFirstString(values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function buildJibeapplyLocation(jobRecord) {
  const full =
    pickFirstString([
      jobRecord?.full_location,
      jobRecord?.location_name,
      jobRecord?.short_location,
      jobRecord?.location,
      jobRecord?.jobLocation
    ]) || "";
  if (full) return full;

  const parts = [
    String(jobRecord?.city || "").trim(),
    String(jobRecord?.state || "").trim(),
    String(jobRecord?.country || "").trim()
  ].filter(Boolean);
  return parts.join(", ");
}

function parseJibeapplyPostingsFromApi(companyNameForPostings, payload, baseOrigin) {
  const jobs = extractJibeapplyJobs(payload);
  const postings = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    const jobRecord =
      job && typeof job === "object" && job.data && typeof job.data === "object"
        ? job.data
        : job;
    if (!jobRecord || typeof jobRecord !== "object") continue;

    const slug = String(jobRecord?.slug || "").trim();
    const canonicalUrl = slug ? `${String(baseOrigin || "").replace(/\/+$/, "")}/jobs/${slug}` : "";
    const postingUrl =
      canonicalUrl ||
      pickFirstString([
        jobRecord?.url,
        jobRecord?.apply_url,
        jobRecord?.applyUrl,
        jobRecord?.jobUrl,
        jobRecord?.externalUrl,
        jobRecord?.external
      ]);
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const location = buildJibeapplyLocation(jobRecord) || null;
    const postingDate =
      pickFirstString([
        jobRecord?.posted_date,
        jobRecord?.publishDate,
        jobRecord?.postedDate,
        jobRecord?.datePosted,
        jobRecord?.update_date,
        jobRecord?.create_date
      ]) || null;
    const description =
      toJibeapplyText(
        pickFirstString([
          jobRecord?.description,
          jobRecord?.responsibilities,
          jobRecord?.qualifications
        ])
      ) || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name:
        pickFirstString([jobRecord?.title, jobRecord?.jobTitle, jobRecord?.position_title]) || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location,
      job_description: description
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}

async function collectPostingsForJibeapplyCompany(company) {
  const config = parseJibeapplyCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "jibeapply";

  const postings = [];
  const seenUrls = new Set();

  for (let page = 1; page <= MAX_PAGES_PER_COMPANY; page += 1) {
    const requestUrl = new URL(config.apiUrl);
    requestUrl.searchParams.set("page", String(page));
    requestUrl.searchParams.set("sortBy", "relevance");
    requestUrl.searchParams.set("descending", "false");
    requestUrl.searchParams.set("internal", "false");

    const response = await fetchWithAtsRateLimit("jibeapply", JIBEAPPLY_RATE_LIMIT_WAIT_MS, requestUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`JibeApply request failed (${response.status}): ${body.slice(0, 180)}`);
    }

    const payload = await response.json();
    const batch = parseJibeapplyPostingsFromApi(companyNameForPostings, payload, config.baseOrigin);
    if (!batch.length) break;

    let added = 0;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      postings.push(posting);
      seenUrls.add(postingUrl);
      added += 1;
    }
    if (!added) break;
  }

  return postings;
}

module.exports = { collectPostingsForJibeapplyCompany, parseJibeapplyCompany };
