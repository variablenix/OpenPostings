const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HIREOLOGY_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseHireologyCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  let host = String(parsed.host || "").toLowerCase().trim();
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  if (!host.endsWith(".hireology.careers")) return null;
  const companySlug = host.slice(0, -".hireology.careers".length);
  if (!companySlug) return null;
  return { host, companySlug };
}

function extractHireologyStartingData(pageHtml) {
  const source = String(pageHtml || "");
  const match = /var\s+startingData\s*=\s*(\{[\s\S]*?\})\s*;/i.exec(source);
  if (!match) return {};
  const raw = String(match[1] || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function buildHireologyApiUrl(companySlug, xdmC = "") {
  const params = new URLSearchParams({
    ref: "career_site",
    ref_m: "application",
    widget: "t",
    sort: "jobs.created_at",
    sort_dir: "desc"
  });
  if (xdmC) {
    params.set("xdm_c", xdmC);
    params.set("xdm_e", `https://${companySlug}.hireology.careers`);
    params.set("xdm_p", "1");
  }
  return `https://api.hireology.com/v2/public/careers/${companySlug}?${params.toString()}`;
}

function parseHireologyPostingsFromApi(companyNameForPostings, payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const items = Array.isArray(source?.data) ? source.data : [];
  const postings = [];
  const seenIds = new Set();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const attributes = item.attributes && typeof item.attributes === "object" ? item.attributes : null;
    const record = attributes || item;

    const postingId = String(record?.id || item?.id || "").trim();
    if (!postingId || seenIds.has(postingId)) continue;

    const organization = record.organization && typeof record.organization === "object" ? record.organization : {};
    const locations = Array.isArray(record.locations) ? record.locations : [];
    const firstLocation = locations[0];
    let location = null;
    if (typeof firstLocation === "string") {
      const normalized = String(firstLocation || "").trim();
      location = normalized || null;
    } else if (firstLocation && typeof firstLocation === "object") {
      const locationParts = [
        String(firstLocation.address || "").trim(),
        String(firstLocation.city || "").trim(),
        String(firstLocation.state || "").trim(),
        String(firstLocation.country || "").trim(),
        String(firstLocation.postal_code || firstLocation.zip_code || "").trim()
      ].filter(Boolean);
      location = locationParts.length > 0 ? locationParts.join(", ") : null;
    }

    const postingUrl =
      String(record.career_site_url || record["career-site-url"] || "").trim() ||
      `https://careers.hireology.com/${String(record.career_site_path || record["career-site-path"] || "").replace(/^\/+/, "")}`;

    postings.push({
      company_name: String(organization.name || "").trim() || companyNameForPostings,
      position_name: String(record.name || "").trim() || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: String(record.created_at || record["created-at"] || "").trim() || null,
      location
    });
    seenIds.add(postingId);
  }

  return postings;
}

async function collectPostingsForHireologyCompany(company) {
  const config = parseHireologyCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySlug;

  const boardResponse = await fetchWithAtsRateLimit("hireology", HIREOLOGY_RATE_LIMIT_WAIT_MS, company.url_string, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!boardResponse.ok) {
    const body = await boardResponse.text();
    throw new Error(`Hireology board request failed (${boardResponse.status}): ${body.slice(0, 180)}`);
  }

  const widgetUrl = `https://careers.hireology.com/${config.companySlug}?widget=t&ref=career_site&ref_m=application`;
  const widgetResponse = await fetchWithAtsRateLimit("hireology", HIREOLOGY_RATE_LIMIT_WAIT_MS, widgetUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!widgetResponse.ok) {
    const body = await widgetResponse.text();
    throw new Error(`Hireology widget request failed (${widgetResponse.status}): ${body.slice(0, 180)}`);
  }

  const startingData = extractHireologyStartingData(await widgetResponse.text());
  const xdmC = String(startingData?.xdm_c || "").trim();
  const careersPath = String(startingData?.careersPath || "").trim() || config.companySlug;
  const apiUrl = buildHireologyApiUrl(careersPath, xdmC);

  const apiResponse = await fetchWithAtsRateLimit("hireology", HIREOLOGY_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Hireology API request failed (${apiResponse.status}): ${body.slice(0, 180)}`);
  }

  const payload = await apiResponse.json();
  return parseHireologyPostingsFromApi(companyNameForPostings, payload);
}

module.exports = { collectPostingsForHireologyCompany, parseHireologyCompany };
