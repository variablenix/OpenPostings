const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const COMEET_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseComeetCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!(host === "www.comeet.com" || host === "comeet.com")) return null;
  const path = String(parsed.pathname || "");
  if (!/\/jobs\//i.test(path)) return null;
  const baseOrigin = `${parsed.protocol || "https:"}//${host}`;
  const boardUrl = `${baseOrigin}${path}${parsed.search || ""}`;
  return { host, boardUrl };
}

function extractComeetPositionsData(pageHtml) {
  const source = String(pageHtml || "");
  const match = /COMPANY_POSITIONS_DATA\s*=\s*(\[[\s\S]*?\])\s*;/i.exec(source);
  if (!match) return [];
  const rawJson = String(match[1] || "").trim();
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function parseComeetPostingsFromHtml(companyNameForPostings, pageHtml) {
  const items = extractComeetPositionsData(pageHtml);
  const postings = [];
  const seenUrls = new Set();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const postingUrl =
      String(item.url_comeet_hosted_page || "").trim() ||
      String(item.url_recruit_hosted_page || "").trim() ||
      String(item.url_active_page || "").trim() ||
      String(item.url_detected_page || "").trim();
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    let location = null;
    if (item.location && typeof item.location === "object") {
      location =
        String(item.location.name || "").trim() ||
        String(item.location.city || "").trim() ||
        String(item.location.state || "").trim() ||
        String(item.location.country || "").trim() ||
        null;
    }

    postings.push({
      company_name: companyNameForPostings || String(item.company_name || "").trim() || "comeet",
      position_name: String(item.name || "").trim() || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: String(item.time_updated || "").trim() || null,
      location
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}

async function collectPostingsForComeetCompany(company) {
  const config = parseComeetCompany(company.url_string);
  if (!config) return [];
  const normalizedCompanyName = String(company?.company_name || "").trim();
  const response = await fetchWithAtsRateLimit("comeet", COMEET_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Comeet request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const pageHtml = await response.text();
  return parseComeetPostingsFromHtml(normalizedCompanyName, pageHtml);
}

module.exports = { collectPostingsForComeetCompany, parseComeetCompany };