const { normalizeSourceUrlString, decodeHtmlEntities, urljoin, toCleanString, stripHtml, extractCompanyNameFromUrlString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { shouldStorePostingByDate } = require("../../helpers/normalize-numbers");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PEOPLEADMIN_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePeopleadminLabelPattern(label) {
  return String(label || "")
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
}

function findPeopleadminTableFieldHtml(pageHtml, labels) {
  const html = String(pageHtml || "");
  const candidates = Array.isArray(labels) ? labels : [];
  for (const label of candidates) {
    const labelPattern = normalizePeopleadminLabelPattern(label);
    if (!labelPattern) continue;
    const pattern = new RegExp(
      `<th[^>]*>\\s*${labelPattern}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
      "i"
    );
    const match = html.match(pattern);
    if (match && match[1]) {
      return String(match[1] || "");
    }
  }
  return "";
}

function htmlToPeopleadminText(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const normalizedBlocks = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n");
  const stripped = stripHtml(decodeHtmlEntities(normalizedBlocks));
  if (!stripped) return "";
  return stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function findPeopleadminTableFieldText(pageHtml, labels) {
  return htmlToPeopleadminText(findPeopleadminTableFieldHtml(pageHtml, labels));
}

function parsePeopleadminCompany(url) {
  const normalizedUrl = normalizeSourceUrlString(url);
  if (!normalizedUrl) return null;
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes("peopleadmin.com")) return null;
  const boardUrl = `${parsed.protocol}//${parsed.host}/postings/search`;
  return {
    normalizedUrl,
    host,
    boardUrl
  };
}

function parsePeopleadminPostingsFromHtml(pageHtml, pageUrl) {
  const html = String(pageHtml || "");
  if (!html) return { postings: [], nextPageUrl: null };
  const postings = [];
  const seenUrls = new Set();

  const itemRegex =
    /<div[^>]*class=['"][^'"]*\bjob-item-posting\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const hrefRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href=['"]([^'"]*\/postings\/\d+)['"][^>]*>([\s\S]*?)<\/a>/i;
  const locationRegex = /<div[^>]*class=['"][^'"]*\btbody-cell\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i;

  let itemMatch;
  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const block = String(itemMatch[1] || "");
    const hrefMatch = block.match(hrefRegex);
    if (!hrefMatch) continue;
    const postingUrl = urljoin(pageUrl, decodeHtmlEntities(hrefMatch[1]));
    if (!postingUrl || seenUrls.has(postingUrl)) continue;
    const title = stripHtml(hrefMatch[2]) || "Untitled Position";
    const locationMatch = block.match(locationRegex);
    const location = locationMatch ? stripHtml(locationMatch[1]) : "";
    postings.push({
      position_name: title,
      job_posting_url: postingUrl,
      location
    });
    seenUrls.add(postingUrl);
  }

  const nextMatch = html.match(
    /<a[^>]*class=['"][^'"]*\bnext_page\b[^'"]*['"][^>]*href=['"]([^'"]+)['"]/i
  );
  const nextPageUrl = nextMatch ? urljoin(pageUrl, decodeHtmlEntities(nextMatch[1])) : null;
  return { postings, nextPageUrl };
}

async function fetchPeopleadminPostingDetail(postingUrl) {
  const res = await fetchWithAtsRateLimit("peopleadmin", PEOPLEADMIN_RATE_LIMIT_WAIT_MS, postingUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT
    }
  });
  if (!res.ok) {
    return {
      posting_date: "",
      location: "",
      job_description: ""
    };
  }
  const detailHtml = await res.text();
  const text = String(detailHtml || "");

  const postingDate =
    findPeopleadminTableFieldText(text, ["Posted Date", "Open Date", "Published Date", "Job Open Date", "Posting Date"]) ||
    "";
  const location =
    findPeopleadminTableFieldText(text, ["Location", "Work Location", "Job Location", "Campus", "Primary Location"]) ||
    "";
  const jobDescription =
    findPeopleadminTableFieldText(text, ["Job Description", "Position Description", "Position Summary", "Job Summary", "Summary", "Description"]) ||
    "";
  const normalizedPostingDate = shouldStorePostingByDate(postingDate) ? postingDate : "";

  return {
    posting_date: normalizedPostingDate,
    location,
    job_description: jobDescription
  };
}

async function collectPostingsForPeopleadminCompany(company) {
  const config = parsePeopleadminCompany(company.url_string);
  if (!config) return [];

  const aggregated = [];
  const seen = new Set();
  let pageUrl = config.boardUrl;

  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page += 1) {
    const res = await fetchWithAtsRateLimit("peopleadmin", PEOPLEADMIN_RATE_LIMIT_WAIT_MS, pageUrl, {
      headers: {
        "User-Agent": DEFAULT_BROWSER_USER_AGENT
      }
    });
    if (!res.ok) break;
    const pageHtml = await res.text();
    const { postings, nextPageUrl } = parsePeopleadminPostingsFromHtml(pageHtml, pageUrl);
    if (!Array.isArray(postings) || postings.length === 0) break;
    let pageAdded = 0;
    for (const posting of postings) {
      const url = toCleanString(posting.job_posting_url);
      if (!url || seen.has(url)) continue;
      const detail = await fetchPeopleadminPostingDetail(url);
      aggregated.push({
        company_name: toCleanString(company.company_name) || extractCompanyNameFromUrlString(config.host) || config.host,
        position_name: toCleanString(posting.position_name) || "Untitled Position",
        location: toCleanString(detail.location || posting.location),
        posting_date: toCleanString(detail.posting_date),
        job_description: toCleanString(detail.job_description),
        job_posting_url: url
      });
      seen.add(url);
      pageAdded += 1;
    }
    if (!nextPageUrl || pageAdded === 0) break;
    pageUrl = nextPageUrl;
  }

  return aggregated;
}


module.exports = { collectPostingsForPeopleadminCompany, parsePeopleadminCompany };
