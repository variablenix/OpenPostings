const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const CAREERSPAGE_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForCareerspageCompany(company) {
  const config = parseCareerspageCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySlugLower;
  const { pageHtml } = await fetchCareerspageBoardPage(config.boardUrl);
  return parseCareerspagePostingsFromHtml(companyNameForPostings, config, pageHtml);
}


function parseCareerspageCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "careerspage.io" && host !== "www.careerspage.io") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length === 0) return null;

  const companySlug = String(pathParts[0] || "").trim();
  if (!companySlug) return null;

  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    boardUrl: `https://careerspage.io/${companySlug}`
  };
}


function cleanCareerspageText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseCareerspagePostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const jobItemPattern = /<div[^>]*class=['"][^'"]*\bjob-item\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let itemMatch = jobItemPattern.exec(source);

  while (itemMatch) {
    const itemHtml = String(itemMatch[1] || "");
    const hrefRaw = String(
      itemHtml.match(/href=['"](https?:\/\/careerspage\.io\/[^'"?#]+\/[^'"?#]+)['"]/i)?.[1] || ""
    ).trim();
    if (!hrefRaw) {
      itemMatch = jobItemPattern.exec(source);
      continue;
    }

    const title = cleanCareerspageText(itemHtml.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)?.[1] || "");
    if (!title) {
      itemMatch = jobItemPattern.exec(source);
      continue;
    }

    let jobUrl = "";
    try {
      jobUrl = new URL(hrefRaw, `${String(config?.boardUrl || "").replace(/\/+$/, "")}/`).toString();
    } catch {
      itemMatch = jobItemPattern.exec(source);
      continue;
    }
    if (!jobUrl || seenUrls.has(jobUrl)) {
      itemMatch = jobItemPattern.exec(source);
      continue;
    }

    const location = cleanCareerspageText(
      itemHtml.match(/fa-location-arrow[^<]*<\/i>\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""
    );
    const employmentType = cleanCareerspageText(
      itemHtml.match(/fa-business-time[^<]*<\/i>\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""
    );

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: null,
      location: location || null,
      employment_type: employmentType || null
    });
    seenUrls.add(jobUrl);
    itemMatch = jobItemPattern.exec(source);
  }

  return postings;
}


async function fetchCareerspageBoardPage(urlString) {
  const res = await fetchWithAtsRateLimit("careerspage", CAREERSPAGE_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CareersPage request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "careerspage.io" && finalHost !== "www.careerspage.io") {
    throw new Error(`CareersPage URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForCareerspageCompany, parseCareerspageCompany };