const { parseUrl, cleanHtmlText, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HOMERUN_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parseHomerunCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (!host.endsWith(".homerun.co")) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}${parsed.pathname || "/"}${parsed.search || ""}`;
  return { host, boardUrl };
}

function extractHomerunJobListPayload(pageHtml) {
  const source = String(pageHtml || "");
  const match = /<job-list[^>]*\bv-bind=['"](?<payload>\{[\s\S]*?\})['"]/i.exec(source);
  if (!match?.groups?.payload) return {};
  const raw = cleanHtmlText(match.groups.payload).replace(/&quot;/g, '"');
  const unescaped = decodeHtmlEntities(raw).replace(/\\\//g, "/");
  if (!unescaped) return {};
  try {
    const parsed = JSON.parse(unescaped);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseHomerunPostingsFromHtml(companyNameForPostings, pageHtml) {
  const payload = extractHomerunJobListPayload(pageHtml);
  const content = payload && typeof payload === "object" ? payload.content : null;
  const vacancies = Array.isArray(content?.vacancies) ? content.vacancies : [];
  const locations = Array.isArray(content?.locations) ? content.locations : [];

  const locationById = new Map();
  for (const location of locations) {
    if (!location || typeof location !== "object") continue;
    const id = Number(location.id);
    const name = String(location.name || "").trim();
    if (!Number.isFinite(id) || !name) continue;
    locationById.set(id, name);
  }

  const postings = [];
  const seenUrls = new Set();
  for (const vacancy of vacancies) {
    if (!vacancy || typeof vacancy !== "object") continue;
    const postingUrl = String(vacancy.url || "").trim().replace(/\\\//g, "/");
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const title = decodeHtmlEntities(String(vacancy.title || "").trim()) || "Untitled Position";
    const locationId = Number(vacancy.location_id);
    const location = Number.isFinite(locationId) ? locationById.get(locationId) || null : null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: null,
      location
    });
    seenUrls.add(postingUrl);
  }
  return postings;
}

async function collectPostingsForHomerunCompany(company) {
  const config = parseHomerunCompany(company.url_string);
  if (!config) return [];
  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0] || "homerun";

  const response = await fetchWithAtsRateLimit("homerun", HOMERUN_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`Homerun request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const pageHtml = await response.text();
  return parseHomerunPostingsFromHtml(companyNameForPostings, pageHtml);
}

module.exports = { collectPostingsForHomerunCompany, parseHomerunCompany };
