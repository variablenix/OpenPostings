const { parseUrl, decodeHtmlEntities, escapeRegExp } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HRMDIRECT_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForHrmDirectCompany(company) {
  const config = parseHrmDirectCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml, finalUrl } = await fetchHrmDirectJobsPage(config.jobsUrl);
  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    jobsUrl: finalUrl || config.jobsUrl
  };
  return parseHrmDirectPostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
}

function parseHrmDirectCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".hrmdirect.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  const jobsUrl = new URL(parsed.toString());
  if (!/\/employment\/job-openings\.php$/i.test(String(jobsUrl.pathname || ""))) {
    jobsUrl.pathname = "/employment/job-openings.php";
  }
  if (!jobsUrl.searchParams.has("search")) {
    jobsUrl.searchParams.set("search", "true");
  }
  jobsUrl.hash = "";

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    jobsUrl: jobsUrl.toString()
  };
}


function cleanHrmDirectText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHrmDirectHref(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/&#job/gi, "")
    .replace(/#job/gi, "")
    .replace(/&{2,}/g, "&")
    .replace(/[&\s]+$/g, "")
    .trim();
}

function extractHrmDirectCellValue(rowHtml, className) {
  const escapedClassName = escapeRegExp(String(className || "").trim());
  if (!escapedClassName) return "";
  const cellRegex = new RegExp(
    `<td[^>]*class=["'][^"']*\\b${escapedClassName}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`,
    "i"
  );
  return String(rowHtml.match(cellRegex)?.[1] || "");
}

function parseHrmDirectPostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const rowPattern =
    /<tr[^>]*class=["'][^"']*\breqitem1?\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch = rowPattern.exec(source);
  while (rowMatch) {
    const rowHtml = String(rowMatch[1] || "");
    const titleCell = extractHrmDirectCellValue(rowHtml, "posTitle");
    const titleLinkMatch = titleCell.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/a>|$)/i);
    const href = normalizeHrmDirectHref(titleLinkMatch?.[1] || "");
    if (!href) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const absoluteUrl = new URL(href, `${config.baseOrigin}/employment/`).toString();
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      rowMatch = rowPattern.exec(source);
      continue;
    }

    const title = cleanHrmDirectText(titleLinkMatch?.[2] || titleCell || "");
    const city = cleanHrmDirectText(extractHrmDirectCellValue(rowHtml, "cities"));
    const state = cleanHrmDirectText(extractHrmDirectCellValue(rowHtml, "state"));
    const department = cleanHrmDirectText(extractHrmDirectCellValue(rowHtml, "departments"));
    const postingDate =
      cleanHrmDirectText(extractHrmDirectCellValue(rowHtml, "date")) ||
      cleanHrmDirectText(extractHrmDirectCellValue(rowHtml, "dates")) ||
      null;
    const location = [city, state].filter(Boolean).join(", ");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: postingDate,
      location: location || null,
      department: department || null
    });
    seenUrls.add(absoluteUrl);
    rowMatch = rowPattern.exec(source);
  }

  return postings;
}


async function fetchHrmDirectJobsPage(urlString) {
  const res = await fetchWithAtsRateLimit("hrmdirect", HRMDIRECT_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HRMDirect page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".hrmdirect.com")) {
    throw new Error(`HRMDirect URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

module.exports = { collectPostingsForHrmDirectCompany, parseHrmDirectCompany };