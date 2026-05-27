const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

const ADP_WORKFORCENOW_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseAdpWorkforcenowCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "workforcenow.adp.com" && host !== "www.workforcenow.adp.com") return null;

  const cid = String(parsed.searchParams?.get("cid") || "").trim();
  const ccId = String(parsed.searchParams?.get("ccId") || "").trim();
  if (!cid || !ccId) return null;

  const baseOrigin = "https://workforcenow.adp.com";
  const boardUrl =
    `${baseOrigin}/mascsr/default/mdf/recruitment/recruitment.html?` +
    `cid=${encodeURIComponent(cid)}&ccId=${encodeURIComponent(ccId)}`;
  const apiBase = `${baseOrigin}/mascsr/default/careercenter/public/events/staffing/v1`;

  return {
    host,
    cid,
    ccId,
    boardUrl,
    jobRequisitionsUrl: `${apiBase}/job-requisitions?cid=${encodeURIComponent(cid)}&ccId=${encodeURIComponent(ccId)}`,
    contentLinksBaseUrl: `${apiBase}/content-links/career-center`
  };
}


function extractAdpWorkforcenowCompanyName(contentLinksJson) {
  const contentLinks = Array.isArray(contentLinksJson?.contentLinks) ? contentLinksJson.contentLinks : [];

  const parseWelcomeName = (rawText) => {
    const source = cleanAdpWorkforcenowText(rawText);
    const patterns = [
      /(?:career\s+center|career\s+portal|careers?)\s+for\s+(.{2,120}?)(?:[,.]|$)/i,
      /\bfor\s+(.{2,120}?)\s+(?:career\s+center|career\s+portal|careers?\b)/i,
      /welcome\s+to\s+(?:the\s+)?(.{2,120}?)\s+(?:career\s+center|career\s+portal|careers?\b|job\s+portal)/i,
      /choose\s+a\s+career\s+at\s+(.{2,120}?)(?:[,.]|$)/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match?.[1]) continue;
      let candidate = cleanAdpWorkforcenowText(match[1]);
      candidate = candidate
        .replace(/\b(career\s+center|career\s+portal|careers?\s+portal)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[-:|,\s]+|[-:|,\s]+$/g, "");
      candidate = candidate.split(/\b(choose\s+a\s+career\s+at|welcome\s+to|if\s+you\s+are|where\s+|our\s+|we\s+)/i)[0]?.trim() || "";
      if (candidate && !["our", "you", "we"].includes(candidate.toLowerCase())) {
        return candidate;
      }
    }
    return "";
  };

  for (const item of contentLinks) {
    const code = String(item?.linkTypeCode?.codeValue || "").trim();
    if (code !== "WELCOME-TXT") continue;
    const parsed = parseWelcomeName(String(item?.linkTypeCode?.longName || ""));
    if (parsed) return parsed;
  }

  for (const item of contentLinks) {
    const code = String(item?.linkTypeCode?.codeValue || "").trim();
    if (code !== "LINKS-BRND") continue;
    const links = Array.isArray(item?.contentBody?.links) ? item.contentBody.links : [];
    for (const link of links) {
      const title = cleanAdpWorkforcenowText(link?.title || "");
      const href = cleanAdpWorkforcenowText(link?.href || "");
      if (title && !["careers", "career", "home", "jobs", "apply"].includes(title.toLowerCase())) {
        return title;
      }
      if (href && !href.includes("workforcenow.adp.com") && !href.includes("jobs/apply/posting.html")) {
        const hrefWithScheme = href.includes("://") ? href : `https://${href}`;
        const parsed = parseUrl(hrefWithScheme);
        const host = String(parsed?.hostname || "").replace(/^www\./i, "").toLowerCase();
        if (host) {
          const derived = slugToAdpWorkforcenowCompanyName(host.split(".")[0] || "");
          if (derived) return derived;
        }
      }
    }
  }

  for (const item of contentLinks) {
    const code = String(item?.linkTypeCode?.codeValue || "").trim();
    if (code !== "IMG_LOGO") continue;
    const body = item?.contentBody && typeof item.contentBody === "object" ? item.contentBody : {};
    const links = Array.isArray(body?.links) ? body.links : [];
    let logoTitle = "";
    for (const link of links) {
      logoTitle = cleanAdpWorkforcenowText(link?.title || "");
      if (logoTitle) break;
    }
    if (!logoTitle) {
      logoTitle = cleanAdpWorkforcenowText(body?.contentTitle || "");
    }
    logoTitle = logoTitle
      .replace(/\.(png|jpg|jpeg|gif|svg|webp)$/i, "")
      .replace(/\b(logo|careers?|career|center|portal|hris|adp|v\d+)\b/gi, " ")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-:|,\s]+|[-:|,\s]+$/g, "");
    if (logoTitle.length >= 3) return logoTitle;
  }

  for (const item of contentLinks) {
    const links = Array.isArray(item?.contentBody?.links) ? item.contentBody.links : [];
    for (const link of links) {
      const href = cleanAdpWorkforcenowText(link?.href || "");
      if (!href.includes("jobs/apply/posting.html")) continue;
      const parsed = parseUrl(href);
      const clientSlug = String(parsed?.searchParams?.get("client") || "").trim();
      const derived = slugToAdpWorkforcenowCompanyName(clientSlug);
      if (derived) return derived;
    }
  }

  return "";
}

function extractAdpWorkforcenowLocation(job) {
  const item = job && typeof job === "object" ? job : {};
  const values = [];
  const seen = new Set();
  const locations = Array.isArray(item?.requisitionLocations) ? item.requisitionLocations : [];
  for (const locationItem of locations) {
    const location = locationItem && typeof locationItem === "object" ? locationItem : {};
    const nameCode = location?.nameCode && typeof location.nameCode === "object" ? location.nameCode : {};
    const label = String(nameCode?.shortName || nameCode?.longName || "").trim();
    const address = location?.address && typeof location.address === "object" ? location.address : {};
    const city = String(address?.cityName || "").trim();
    const stateData =
      address?.countrySubdivisionLevel1 && typeof address.countrySubdivisionLevel1 === "object"
        ? address.countrySubdivisionLevel1
        : {};
    const state = String(stateData?.codeValue || stateData?.longName || "").trim();
    const countryData = address?.country && typeof address.country === "object" ? address.country : {};
    const country = String(countryData?.codeValue || countryData?.longName || "").trim();
    const addressLabel = [city, state, country].filter(Boolean).join(", ");
    const combined = [label, addressLabel].filter(Boolean).join(" - ").trim();
    const normalized = combined.toLowerCase();
    if (!combined || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(combined);
  }
  return values.length > 0 ? values.join(" / ") : null;
}

function buildAdpWorkforcenowPostingUrl(item, config) {
  const job = item && typeof item === "object" ? item : {};
  const links = Array.isArray(job?.links) ? job.links : [];
  for (const link of links) {
    const href = String(link?.href || "").trim();
    if (!href) continue;
    const absolute = parseUrl(href) ? href : new URL(href, config.boardUrl).toString();
    if (absolute) return absolute;
  }
  const itemId = String(job?.itemID || "").trim();
  if (itemId) {
    return `${config.boardUrl}&jobId=${encodeURIComponent(itemId)}`;
  }
  return config.boardUrl;
}


function cleanAdpWorkforcenowText(value) {
  let text = String(value || "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep undecoded value when malformed.
  }
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function slugToAdpWorkforcenowCompanyName(slug) {
  const cleaned = String(slug || "").trim().replace(/^[-_]+|[-_]+$/g, "");
  if (!cleaned) return "";
  const normalized = cleaned
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!normalized) return "";
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part === part.toUpperCase() && part.length <= 5 ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(" ");
}

function parseAdpWorkforcenowPostingsFromApi(companyNameForPostings, config, responseJson) {
  const jobs = Array.isArray(responseJson?.jobRequisitions) ? responseJson.jobRequisitions : [];
  const postings = [];
  const seenUrls = new Set();
  const seenIds = new Set();

  for (const row of jobs) {
    const item = row && typeof row === "object" ? row : {};
    const itemId = String(item?.itemID || "").trim();
    if (itemId && seenIds.has(itemId)) continue;

    const jobUrl = buildAdpWorkforcenowPostingUrl(item, config);
    if (!jobUrl || seenUrls.has(jobUrl)) continue;

    postings.push({
      company_name: companyNameForPostings,
      position_name: String(item?.requisitionTitle || "").trim() || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: String(item?.postDate || "").trim() || null,
      location: extractAdpWorkforcenowLocation(item),
      employment_type: String(item?.workLevelCode?.shortName || "").trim() || null,
      department: null
    });
    seenUrls.add(jobUrl);
    if (itemId) seenIds.add(itemId);
  }

  return postings;
}

async function collectPostingsForAdpWorkforcenowCompany(company) {
  const config = parseAdpWorkforcenowCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const contentLinksJson = await fetchAdpWorkforcenowContentLinks(config);
  const inferredCompanyName = extractAdpWorkforcenowCompanyName(contentLinksJson);
  const companyNameForPostings = normalizedCompanyName || inferredCompanyName || config.ccId.toLowerCase();
  const responseJson = await fetchAdpWorkforcenowJobsPage(config);
  return parseAdpWorkforcenowPostingsFromApi(companyNameForPostings, config, responseJson);
}


async function fetchAdpWorkforcenowContentLinks(config) {
  const url =
    `${config.contentLinksBaseUrl}?cid=${encodeURIComponent(config.cid)}` +
    `&timeStamp=${Date.now()}&ccId=${encodeURIComponent(config.ccId)}&locale=en_US&lang=en_US`;
  const res = await fetchWithAtsRateLimit("adp_workforcenow", ADP_WORKFORCENOW_RATE_LIMIT_WAIT_MS, url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADP Workforce Now content-links request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res.json();
}

async function fetchAdpWorkforcenowJobsPage(config) {
  const res = await fetchWithAtsRateLimit(
    "adp_workforcenow",
    ADP_WORKFORCENOW_RATE_LIMIT_WAIT_MS,
    config.jobRequisitionsUrl,
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*"
      }
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADP Workforce Now job-requisitions request failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res.json();
}

module.exports = { collectPostingsForAdpWorkforcenowCompany, parseAdpWorkforcenowCompany };