const { decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SMARTRECRUITERS_RATE_LIMIT_WAIT_MS = 1000;
const SMARTRECRUITERS_ESTIMATED_COMPANY_COUNT = 4000;
const SMARTRECRUITERS_INSERT_EVERY_N_TARGETS = 10;

function cleanSmartRecruitersText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSmartRecruitersLocationLabel(locationObj, shortLocation) {
  const shortValue = cleanSmartRecruitersText(shortLocation);
  if (shortValue) return shortValue;

  const locationData = locationObj && typeof locationObj === "object" ? locationObj : {};
  const city = cleanSmartRecruitersText(locationData.city);
  const region = cleanSmartRecruitersText(locationData.region);
  const country = cleanSmartRecruitersText(locationData.country);
  const parts = [city, region, country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

async function collectPostingsForSmartRecruitersDynamic(limit = 100) {
  const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const endpoint = new URL("https://jobs.smartrecruiters.com/sr-jobs/search");
  endpoint.searchParams.set("limit", String(cappedLimit));
  endpoint.searchParams.set("_", String(Date.now()));

  const res = await fetchWithAtsRateLimit(
    "smartrecruiters",
    SMARTRECRUITERS_RATE_LIMIT_WAIT_MS,
    endpoint.toString(),
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartRecruiters request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const payload = await res.json();
  const contentItems = Array.isArray(payload?.content) ? payload.content : [];
  const postings = [];
  const seenUrls = new Set();

  for (const item of contentItems) {
    if (!item || typeof item !== "object") continue;

    const jobUrl = cleanSmartRecruitersText(item.applyUrl);
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    const company = item.company && typeof item.company === "object" ? item.company : {};
    const companyName = cleanSmartRecruitersText(company.name) || "Unknown Company";
    const title = cleanSmartRecruitersText(item.name) || "Untitled Position";
    const location = buildSmartRecruitersLocationLabel(item.location, item.shortLocation);
    const postedDate = cleanSmartRecruitersText(item.releasedDate) || null;

    postings.push({
      company_name: companyName,
      position_name: title,
      job_posting_url: jobUrl,
      posting_date: postedDate,
      location
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

module.exports = { collectPostingsForSmartRecruitersDynamic, SMARTRECRUITERS_ESTIMATED_COMPANY_COUNT, SMARTRECRUITERS_INSERT_EVERY_N_TARGETS}