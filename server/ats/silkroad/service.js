
const { parseUrl, urljoin, stripHtml, toCleanString, decodeHtmlEntities, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { nowEpochSeconds, shouldStorePostingByDate, parsePostingDateToEpochSeconds } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const SILKROAD_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForSilkroadCompany(company) {
  const config = parseSilkroadCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.companyKey || config.companyKeyLower;

  const seenPostingUrls = new Set();
  const allPostings = [];
  let currentPage = 1;
  let totalPages = 1;
  const maxPageHardLimit = 100;

  while (currentPage <= totalPages && currentPage <= maxPageHardLimit) {
    const pageUrl =
      currentPage <= 1 ? config.boardUrl : `${config.boardUrl}?page=${encodeURIComponent(currentPage)}`;

    const boardRes = await fetchWithAtsRateLimit("silkroad", SILKROAD_RATE_LIMIT_WAIT_MS, pageUrl, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_BROWSER_USER_AGENT }
    });
    if (!boardRes.ok) {
      const body = await boardRes.text();
      throw new Error(`SilkRoad board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
    }

    const finalPageUrl = String(boardRes.url || pageUrl || "").trim();
    const finalHost = String(parseUrl(finalPageUrl)?.hostname || "").toLowerCase();
    if (finalHost !== "jobs.silkroad.com" && finalHost !== "www.jobs.silkroad.com") {
      throw new Error(`SilkRoad URL redirected to unexpected host: ${finalPageUrl}`);
    }

    const boardHtml = await boardRes.text();
    const parsedPage = parseSilkroadPostingsFromHtml(companyNameForPostings, boardHtml, finalPageUrl);
    if (!parsedPage.validBoard) {
      if (currentPage === 1) {
        throw new Error("Unexpected SilkRoad board HTML shape");
      }
      break;
    }

    totalPages = Math.max(totalPages, Number(parsedPage.totalPages || 1));
    if (parsedPage.postings.length === 0) {
      if (parsedPage.hasNoJobsState) return [];
      break;
    }

    for (const posting of parsedPage.postings) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenPostingUrls.has(postingUrl)) continue;
      seenPostingUrls.add(postingUrl);
      allPostings.push(posting);
    }

    currentPage += 1;
  }

  const freshPostings = [];
  const referenceEpoch = nowEpochSeconds();
  for (const posting of allPostings) {
    const postingUrl = String(posting?.job_posting_url || "").trim();
    if (!postingUrl) continue;
    try {
      const detailRes = await fetchWithAtsRateLimit("silkroad", SILKROAD_RATE_LIMIT_WAIT_MS, postingUrl, {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_BROWSER_USER_AGENT,
          Referer: config.boardUrl
        }
      });
      if (!detailRes.ok) continue;
      const detailHtml = await detailRes.text();
      const postingDate = extractSilkroadPostingDateFromDetailHtml(detailHtml);
      if (!postingDate) continue;
      if (!shouldStorePostingByDate(postingDate, referenceEpoch)) continue;
      posting.posting_date = postingDate;
      freshPostings.push(posting);
    } catch {
      // Skip posting if detail fetch/date extraction fails.
    }
  }

  return freshPostings;
}

function parseSilkroadCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "jobs.silkroad.com" && host !== "www.jobs.silkroad.com") return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (pathParts.length < 2) return null;

  const companyKey = String(pathParts[0] || "").trim();
  const careersPart = String(pathParts[1] || "").trim();
  if (!companyKey || careersPart.toLowerCase() !== "careers") return null;

  const boardUrl = `https://jobs.silkroad.com/${companyKey}/Careers`;
  return {
    host,
    companyKey,
    companyKeyLower: companyKey.toLowerCase(),
    boardUrl
  };
}



function extractSilkroadPostingDateFromDetailHtml(detailHtml) {
  const source = String(detailHtml || "");
  if (!source) return null;

  const patterns = [
    /["']datePosted["']\s*:\s*["']([^"']+)["']/i,
    /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
    /&quot;datePosted&quot;\s*:\s*&quot;([^&]+)&quot;/i,
    /&quot;datePublished&quot;\s*:\s*&quot;([^&]+)&quot;/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    const raw = toCleanString(decodeHtmlEntities(match?.[1] || ""));
    if (!raw) continue;
    const parsedEpoch = parsePostingDateToEpochSeconds(raw, nowEpochSeconds());
    if (!parsedEpoch) continue;
    return new Date(parsedEpoch * 1000).toISOString();
  }

  return null;
}

function extractSilkroadTotalPagesFromHtml(pageHtml) {
  const source = String(pageHtml || "");
  if (!source) return 1;
  const pageMatch = source.match(
    /id=["']Jobs_PagedJobList_CurrentPageText["'][^>]*>\s*Page\s*\d+\s*of\s*(\d+)/i
  );
  const totalPages = Number(pageMatch?.[1] || 0);
  if (!Number.isFinite(totalPages) || totalPages < 1) return 1;
  return Math.max(1, Math.min(100, Math.floor(totalPages)));
}

function parseSilkroadPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return { postings: [], validBoard: false, hasNoJobsState: false, totalPages: 1 };

  const lower = source.toLowerCase();
  const hasSearchOrHeaderMarker =
    lower.includes('id="jobs_jobsearch_searchform"') || lower.includes('id="base_layout_jobsheaderlink"');
  const hasNoJobsState = lower.includes('id="jobs_jobsearchresults_nojobs_pageheading"');
  const totalPages = extractSilkroadTotalPagesFromHtml(source);
  if (!hasSearchOrHeaderMarker) {
    return { postings: [], validBoard: false, hasNoJobsState, totalPages };
  }

  const postings = [];
  const seenUrls = new Set();
  const linkPattern = /<a[^>]*id=["']Jobs_PagedJobList_Job-(\d+)["'][^>]*class=["'][^"']*\bsr-panel\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern =
    /<div[^>]*id=["']Jobs_PagedJobList_JobTitle-\d+["'][^>]*>([\s\S]*?)<\/div>/i;
  const locationPattern =
    /<div[^>]*id=["']Jobs_PagedJobList_JobLocation-\d+["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*\bsr-panel__meta\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;

  let match = linkPattern.exec(source);
  while (match) {
    const postingId = toCleanString(decodeHtmlEntities(match[1] || ""));
    const href = toCleanString(decodeHtmlEntities(match[2] || ""));
    const block = String(match[3] || "");
    const postingUrl = urljoin(pageUrl, href);
    if (!postingUrl || seenUrls.has(postingUrl)) {
      match = linkPattern.exec(source);
      continue;
    }

    const title = toCleanString(stripHtml(titlePattern.exec(block)?.[1] || "")) || "Untitled Position";
    const location = toCleanString(stripHtml(locationPattern.exec(block)?.[1] || "")) || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: postingUrl,
      posting_date: null,
      location,
      external_job_id: postingId || null
    });
    seenUrls.add(postingUrl);
    match = linkPattern.exec(source);
  }

  return { postings, validBoard: true, hasNoJobsState, totalPages };
}

module.exports = { collectPostingsForSilkroadCompany, parseSilkroadCompany };
