
const { decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const POLICEAPP_RATE_LIMIT_WAIT_MS = 60 * 1000;
const POLICEAPP_ESTIMATED_COMPANY_COUNT = 1166;

function cleanPoliceappText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePoliceappJobUrl(rawUrl, baseOrigin = "https://www.policeapp.com") {
  let value = String(rawUrl || "").trim();
  if (!value) return "";
  if (value.startsWith("/")) {
    value = new URL(value, `${baseOrigin}/`).toString();
  } else if (!/^https?:\/\//i.test(value)) {
    value = new URL(value, `${baseOrigin}/`).toString();
  }
  value = value.replace(
    /^(https?:\/\/www\.policeapp\.com\/)jobs\/urlrewrite_jobpostings\//i,
    "$1"
  );
  return value;
}

function parsePoliceappPostingsFromHtml(responseHtml) {
  const source = String(responseHtml || "");
  if (!source) return [];

  const postings = [];
  const seenUrls = new Set();
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let linkMatch = linkRegex.exec(source);
  while (linkMatch) {
    const hrefRaw = cleanPoliceappText(linkMatch[1]);
    const hrefLower = hrefRaw.toLowerCase();
    if (!hrefLower || hrefLower.startsWith("javascript:") || hrefLower.startsWith("#")) {
      linkMatch = linkRegex.exec(source);
      continue;
    }
    if (!/\/\d+\/?$/.test(hrefLower)) {
      linkMatch = linkRegex.exec(source);
      continue;
    }

    const jobPostingUrl = normalizePoliceappJobUrl(hrefRaw);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) {
      linkMatch = linkRegex.exec(source);
      continue;
    }

    const anchorHtml = String(linkMatch[2] || "");
    const titleMatch = anchorHtml.match(
      /<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );
    const bodyText = cleanPoliceappText(anchorHtml);
    const titlePart = cleanPoliceappText(titleMatch?.[1] || "") || bodyText.split(/deadline\s*:/i)[0].trim();
    const positionName = titlePart || "Untitled Position";
    const locationPart = positionName.split(" - ")[0].trim();
    const location = locationPart || null;

    const companyName = positionName.includes(" - ")
      ? positionName.split(" - ", 1)[0].trim() || "Unknown Company"
      : "Unknown Company";

    postings.push({
      company_name: companyName,
      position_name: positionName,
      job_posting_url: jobPostingUrl,
      posting_date: "Posted Today",
      location
    });
    seenUrls.add(jobPostingUrl);
    linkMatch = linkRegex.exec(source);
  }

  return postings;
}

async function collectPostingsForPoliceappDynamic() {
  const endpoint =
    "https://www.policeapp.com/jobs/urlrewrite_jobpostings/jobResultsAjax.ashx?j=0&r=50&s=0&p=0";
  const res = await fetchWithAtsRateLimit("policeapp", POLICEAPP_RATE_LIMIT_WAIT_MS, endpoint, {
    method: "GET",
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PoliceApp request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const html = await res.text();
  return parsePoliceappPostingsFromHtml(html);
}

module.exports = { collectPostingsForPoliceappDynamic, POLICEAPP_ESTIMATED_COMPANY_COUNT };
