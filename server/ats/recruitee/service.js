const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const RECRUITEE_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForRecruiteeCompany(company) {
  const config = parseRecruiteeCompany(company.url_string);
  if (!config) return [];

  const response = await fetchRecruiteePublicApp(config.baseUrl);
  const appConfig = response?.appConfig && typeof response.appConfig === "object" ? response.appConfig : {};
  const preferredLangCode = String(appConfig?.primaryLangCode || "").trim();
  const offers = Array.isArray(appConfig?.offers) ? appConfig.offers : [];
  const locations = Array.isArray(appConfig?.locations) ? appConfig.locations : [];

  const locationById = new Map();
  for (const location of locations) {
    const id = String(location?.id ?? "").trim();
    if (!id) continue;
    const label = buildRecruiteeLocationLabel(location, preferredLangCode);
    if (label) locationById.set(id, label);
  }

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings =
    normalizedCompanyName && normalizedCompanyName.toLowerCase() !== "recruitee"
      ? normalizedCompanyName
      : config.subdomain;

  const collected = [];
  for (const offer of offers) {
    const slug = String(offer?.slug || "").trim();
    const jobUrl = slug ? `${config.baseUrl}/o/${slug}` : config.baseUrl;
    if (!jobUrl) continue;

    const publishedValue =
      offer?.publishedAt ?? offer?.published_at ?? offer?.createdAt ?? offer?.created_at ?? offer?.updatedAt;
    let postingDate = null;
    if (typeof publishedValue === "string" && publishedValue.trim()) {
      postingDate = publishedValue.trim();
    } else if (typeof publishedValue === "number" && Number.isFinite(publishedValue) && publishedValue > 0) {
      postingDate = new Date(publishedValue).toISOString();
    }

    const locationIds = Array.isArray(offer?.locationIds) ? offer.locationIds : [];
    const locationNames = locationIds
      .map((locationId) => locationById.get(String(locationId ?? "").trim()) || "")
      .filter(Boolean);

    collected.push({
      company_name: companyNameForPostings,
      position_name: extractRecruiteeTitle(offer, preferredLangCode),
      job_posting_url: jobUrl,
      posting_date: postingDate,
      location: locationNames.length > 0 ? locationNames.join(" / ") : null
    });
  }

  return collected;
}

function parseRecruiteeCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;
  if (!String(parsed.hostname || "").toLowerCase().endsWith(".recruitee.com")) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const normalizedPathParts = pathParts[0]?.toLowerCase() === "o" ? [] : pathParts;
  const basePath = normalizedPathParts.length > 0 ? `/${normalizedPathParts.join("/")}` : "";
  const baseUrl = `${parsed.origin}${basePath}`.replace(/\/+$/, "");
  const [subdomain = ""] = parsed.hostname.split(".");

  return {
    baseUrl: baseUrl || parsed.origin,
    subdomain: String(subdomain || "").toLowerCase()
  };
}

function extractRecruiteePropsFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const patterns = [
    /data-component=(?:"|')PublicApp(?:"|')[^>]*data-props=(?:"|')([^"']+)(?:"|')/is,
    /data-props=(?:"|')([^"']+)(?:"|')[^>]*data-component=(?:"|')PublicApp(?:"|')/is
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const encodedProps = String(match?.[1] || "");
    if (!encodedProps) continue;

    const decodedProps = decodeHtmlEntities(encodedProps);
    try {
      const parsedProps = JSON.parse(decodedProps);
      if (parsedProps && typeof parsedProps === "object") return parsedProps;
    } catch {
      // Continue with the next extraction pattern.
    }
  }

  return null;
}

function pickRecruiteeTranslation(translations, preferredLangCode = "") {
  const byLang = translations && typeof translations === "object" ? translations : {};
  const candidates = [];
  const preferred = String(preferredLangCode || "").trim();

  if (preferred && byLang[preferred] && typeof byLang[preferred] === "object") {
    candidates.push(byLang[preferred]);
  }
  if (byLang.en && typeof byLang.en === "object") {
    candidates.push(byLang.en);
  }
  for (const value of Object.values(byLang)) {
    if (value && typeof value === "object") candidates.push(value);
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate;
  }

  return {};
}

function extractRecruiteeTitle(offer, preferredLangCode = "") {
  const translation = pickRecruiteeTranslation(offer?.translations, offer?.primaryLangCode || preferredLangCode);
  const title = String(translation?.title || translation?.name || offer?.slug || "").trim();
  return title || "Untitled Position";
}

function buildRecruiteeLocationLabel(location, preferredLangCode = "") {
  const translation = pickRecruiteeTranslation(location?.translations, preferredLangCode);
  const name = String(translation?.name || translation?.city || location?.name || "").trim();
  const country = String(translation?.country || "").trim();
  if (name && country) return `${name}, ${country}`;
  return name || country || null;
}

async function fetchRecruiteePublicApp(baseUrl) {
  const res = await fetchWithAtsRateLimit("recruitee", RECRUITEE_RATE_LIMIT_WAIT_MS, baseUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Recruitee request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const pageHtml = await res.text();
  const props = extractRecruiteePropsFromHtml(pageHtml);
  if (!props) {
    throw new Error("Recruitee payload not found in PublicApp data-props");
  }
  return props;
}

module.exports = { collectPostingsForRecruiteeCompany, parseRecruiteeCompany };