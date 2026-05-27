
const { parseUrl, decodeHtmlEntities, toCleanString, urljoin, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");

function parseYcombinatorCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (host !== "www.ycombinator.com" && host !== "ycombinator.com") return null;
  const parts = String(parsed.pathname || "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 3 || parts[0] !== "companies" || parts[2] !== "jobs") return null;
  const slug = String(parts[1] || "").trim();
  if (!slug) return null;
  const boardUrl = `${parsed.protocol || "https:"}//${host}/companies/${slug}/jobs`;
  return { host, slug, boardUrl };
}

function parseYcombinatorPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  const componentMatch = source.match(
    /<div[^>]*id="WaasShowJobsPage-react-component-[^"]+"[^>]*data-page="(?<data>[\s\S]*?)"/i
  );
  const rawPayload = String(componentMatch?.groups?.data || "").trim();
  if (!rawPayload) return [];

  let parsedPayload = null;
  try {
    parsedPayload = JSON.parse(decodeHtmlEntities(rawPayload));
  } catch {
    return [];
  }

  const props = parsedPayload && typeof parsedPayload === "object" ? parsedPayload.props || {} : {};
  const companyObj = props && typeof props === "object" ? props.company || {} : {};
  const effectiveCompanyName =
    toCleanString(companyObj?.name) || toCleanString(companyNameForPostings) || "Unknown Company";
  const jobs = Array.isArray(props?.jobPostings) ? props.jobPostings : [];
  const postings = [];
  const seenUrls = new Set();

  for (const item of jobs) {
    if (!item || typeof item !== "object") continue;
    const rawJobUrl = toCleanString(item.url) || toCleanString(item.applyUrl);
    const jobUrl = urljoin(pageUrl, rawJobUrl) || rawJobUrl;
    if (!jobUrl || seenUrls.has(jobUrl)) continue;
    postings.push({
      company_name: effectiveCompanyName,
      position_name: toCleanString(item.title) || "Untitled Position",
      job_posting_url: jobUrl,
      posting_date: toCleanString(item.createdAt) || null,
      location: toCleanString(item.location) || null
    });
    seenUrls.add(jobUrl);
  }

  return postings;
}

async function collectPostingsForYcombinatorCompany(company) {
  const config = parseYcombinatorCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = toCleanString(company?.company_name);
  const companyNameForPostings = normalizedCompanyName || config.slug || "ycombinator";
  const res = await fetchWithAtsRateLimit("ycombinator", 60 * 1000, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  const finalUrl = String(res.url || config.boardUrl).trim();
  return parseYcombinatorPostingsFromHtml(companyNameForPostings, pageHtml, finalUrl);
}

module.exports = { collectPostingsForYcombinatorCompany, parseYcombinatorCompany };
