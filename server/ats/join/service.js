const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const JOIN_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForJoinCompany(company) {
  const config = parseJoinCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companySlugLower;
  const { pageHtml, finalUrl } = await fetchJoinCompanyPage(config.boardUrl);
  const finalConfig = parseJoinCompany(finalUrl || config.boardUrl) || config;
  const nextData = extractJoinNextDataJsonFromHtml(pageHtml);
  return parseJoinPostingsFromNextData(companyNameForPostings, finalConfig.companySlug || config.companySlug, nextData);
}


function parseJoinCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "join.com" && host !== "www.join.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length < 2 || String(pathParts[0] || "").toLowerCase() !== "companies") return null;

  const companySlug = String(pathParts[1] || "").trim();
  if (!companySlug) return null;

  return {
    host,
    companySlug,
    companySlugLower: companySlug.toLowerCase(),
    boardUrl: `${parsed.protocol}//${parsed.host}/companies/${companySlug}`
  };
}


function extractJoinNextDataJsonFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  const match = source.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/i
  );
  if (!match?.[1]) return {};
  try {
    return JSON.parse(String(match[1] || "").trim());
  } catch {
    return {};
  }
}

function cleanJoinText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function buildJoinJobUrl(companySlug, idParam) {
  const slug = cleanJoinText(companySlug);
  const jobIdParam = cleanJoinText(idParam);
  if (!slug || !jobIdParam) return "";
  return `https://join.com/companies/${encodeURIComponent(slug)}/${encodeURIComponent(jobIdParam)}`;
}

function parseJoinPostingsFromNextData(companyNameForPostings, companySlug, nextData) {
  const props = nextData && typeof nextData === "object" ? nextData.props : {};
  const pageProps = props && typeof props === "object" ? props.pageProps : {};
  const initialState = pageProps && typeof pageProps === "object" ? pageProps.initialState : {};
  const jobsState = initialState && typeof initialState === "object" ? initialState.jobs : {};
  const items = Array.isArray(jobsState?.items) ? jobsState.items : [];

  const postings = [];
  const seenUrls = new Set();

  for (const job of items) {
    const item = job && typeof job === "object" ? job : {};
    const idParam = cleanJoinText(item?.idParam || "");
    const postingUrl = buildJoinJobUrl(companySlug, idParam);
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    const city = item?.city && typeof item.city === "object" ? item.city : {};
    const cityName = cleanJoinText(city?.cityName || "");
    const countryName = cleanJoinText(city?.countryName || "");
    const locationParts = [cityName, countryName].filter(Boolean);
    let location = locationParts.join(", ");

    const workplaceType = cleanJoinText(item?.workplaceType || "");
    const remoteType = cleanJoinText(item?.remoteType || "");
    if (!location && workplaceType.toUpperCase() === "REMOTE") {
      location = "Remote";
    } else if (!location && remoteType) {
      location = remoteType;
    }

    const category = item?.category && typeof item.category === "object" ? item.category : {};
    const employmentType = item?.employmentType && typeof item.employmentType === "object" ? item.employmentType : {};

    postings.push({
      company_name: companyNameForPostings,
      position_name: cleanJoinText(item?.title || "") || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: cleanJoinText(item?.createdAt || "") || null,
      location: location || null,
      department: cleanJoinText(category?.name || "") || null,
      employment_type: cleanJoinText(employmentType?.name || "") || null
    });
    seenUrls.add(postingUrl);
  }

  return postings;
}



async function fetchJoinCompanyPage(urlString) {
  const res = await fetchWithAtsRateLimit("join", JOIN_RATE_LIMIT_WAIT_MS, urlString, {
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
    throw new Error(`JOIN page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "join.com" && finalHost !== "www.join.com") {
    throw new Error(`JOIN URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForJoinCompany, parseJoinCompany };