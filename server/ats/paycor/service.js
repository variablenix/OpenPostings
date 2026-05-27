const { parseUrl, normalizeSourceUrlString, decodeHtmlEntities, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { nowEpochSeconds, parsePostingDateToEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PAYCOR_RATE_LIMIT_WAIT_MS = 60 * 1000;
async function collectPostingsForPaycorCompany(company) {
  const config = parsePaycorCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const boardRes = await fetchWithAtsRateLimit("paycor", PAYCOR_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: { "User-Agent": DEFAULT_BROWSER_USER_AGENT }
  });
  if (!boardRes.ok) {
    const body = await boardRes.text();
    throw new Error(`Paycor board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
  }

  const finalBoardUrl = String(boardRes.url || config.boardUrl || "").trim();
  const boardHtml = await boardRes.text();
  const resolvedClientId =
    String(parseUrl(finalBoardUrl)?.searchParams?.get("clientId") || "").trim() || String(config.clientId || "").trim();
  const companyNameForPostings =
    normalizedCompanyName || extractPaycorCompanyNameFromHtml(boardHtml, resolvedClientId);

  const parsedBoard = parsePaycorPostingsFromHtml(companyNameForPostings, boardHtml, finalBoardUrl);
  if (!parsedBoard.validBoard) return [];
  if (parsedBoard.postings.length === 0) return [];

  const collected = [];
  const referenceEpoch = nowEpochSeconds();
  const syncFallbackPostingDateIso = new Date(referenceEpoch * 1000).toISOString();
  for (const posting of parsedBoard.postings) {
    let postingDate = String(posting?.posting_date || "").trim();
    let location = String(posting?.location || "").trim();
    if (!location) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (postingUrl) {
        try {
          const detailRes = await fetchWithAtsRateLimit("paycor", PAYCOR_RATE_LIMIT_WAIT_MS, postingUrl, {
            method: "GET",
            headers: {
              "User-Agent": DEFAULT_BROWSER_USER_AGENT,
              Referer: finalBoardUrl
            }
          });
          if (detailRes.ok) {
            const detailHtml = await detailRes.text();
            if (!postingDate) {
              postingDate = String(extractPaycorPostingDateFromDetailHtml(detailHtml) || "").trim();
            }
            if (!location) {
              location = String(extractPaycorLocationFromHtml(detailHtml) || "").trim();
            }
          }
        } catch {
          if (!postingDate) postingDate = "";
        }
      }
    }

    if (postingDate && !shouldStorePostingByDate(postingDate, referenceEpoch)) continue;
    posting.posting_date = postingDate || syncFallbackPostingDateIso;
    posting.location = location || null;
    collected.push(posting);
  }

  return collected;
}


function parsePaycorCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  const clientId = String(parsed.searchParams?.get("clientId") || "").trim();
  const pathLower = String(parsed.pathname || "").toLowerCase();
  const looksLikePaycorHost = host === "recruitingbypaycor.com" || host === "www.recruitingbypaycor.com";
  const looksLikePaycorPath =
    pathLower.includes("/career/careerhome.action") ||
    pathLower.includes("/career/jobintroduction.action") ||
    pathLower.includes("/career/careerhomesearch.action");
  if (!looksLikePaycorHost && !looksLikePaycorPath && !clientId) return null;

  const normalizedInputUrl = normalizeSourceUrlString(urlString);
  const boardUrl = clientId
    ? `https://recruitingbypaycor.com/career/CareerHome.action?clientId=${encodeURIComponent(clientId)}`
    : normalizedInputUrl;

  if (!boardUrl) return null;
  return {
    boardUrl,
    clientId,
    clientIdLower: clientId.toLowerCase()
  };
}



function cleanPaycorText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPaycorCompanyNameFromHtml(pageHtml, fallbackClientId = "") {
  const source = String(pageHtml || "");
  const candidates = [];

  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) candidates.push(cleanPaycorText(titleMatch[1]));

  const metaRegex = /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*>/gi;
  let metaMatch = metaRegex.exec(source);
  while (metaMatch) {
    const value = cleanPaycorText(metaMatch[1]);
    if (value) candidates.push(value);
    metaMatch = metaRegex.exec(source);
  }

  for (const candidateRaw of candidates) {
    const candidate = String(candidateRaw || "").trim();
    if (!candidate) continue;
    const splitPipe = candidate.split("|").map((part) => part.trim()).filter(Boolean);
    if (splitPipe.length > 1) return splitPipe[splitPipe.length - 1];
    const normalized = candidate
      .replace(/^current openings\s*[-:|]\s*/i, "")
      .replace(/\s*[-:|]\s*careers?$/i, "")
      .replace(/\s*\|\s*careers?$/i, "")
      .trim();
    if (normalized) return normalized;
  }

  return String(fallbackClientId || "").trim() || "unknown_company_id";
}

function parsePaycorPostingDateFromJobId(jobId) {
  const raw = String(jobId || "").trim();
  if (!raw) return null;
  const yyyymmddMatch = raw.match(/(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[0-1])/);
  if (!yyyymmddMatch) return null;

  const year = Number(yyyymmddMatch[1]);
  const month = Number(yyyymmddMatch[2]);
  const day = Number(yyyymmddMatch[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractPaycorLocationFromHtml(sourceHtml) {
  const source = String(sourceHtml || "");
  if (!source) return null;

  const patterns = [
    /<div[^>]*class=["'][^"']*\bgnewtonCareerGroupJobDescriptionClass\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class=["'][^"']*\bgnewtonJobLocation\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<td[^>]*id=["']gnewtonJobLocationInfo["'][^>]*>([\s\S]*?)<\/td>/i,
    /<b>\s*Location\s*:?\s*<\/b>\s*([^<\r\n]+)/i,
    /(?:^|[\s>])Location\s*:\s*([A-Za-z][^<\r\n]{2,})/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    const location = cleanPaycorText(match?.[1] || "");
    if (location) return location;
  }

  return null;
}

function extractPaycorPostingDateFromDetailHtml(detailHtml) {
  const source = String(detailHtml || "");
  if (!source) return null;

  const datePatterns = [
    /<b>\s*(?:Date\s*Posted|Posted\s*Date|Posting\s*Date)\s*:?\s*<\/b>\s*([^<\r\n]+)/i,
    /(?:Date\s*Posted|Posted\s*Date|Posting\s*Date)\s*:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})/i,
    /(?:Date\s*Posted|Posted\s*Date|Posting\s*Date)\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  ];
  for (const pattern of datePatterns) {
    const match = pattern.exec(source);
    const candidate = cleanPaycorText(match?.[1] || "");
    if (!candidate) continue;
    const epoch = parsePostingDateToEpochSeconds(candidate, nowEpochSeconds());
    if (!epoch) continue;
    return new Date(epoch * 1000).toISOString();
  }

  const jobIdMatch =
    source.match(/<td[^>]*id=["']gnewtonJobID["'][^>]*>[\s\S]*?<b>\s*Job\s*Id:\s*<\/b>\s*([^<\r\n]+)/i) ||
    source.match(/Job\s*Id:\s*([A-Za-z0-9_-]+)/i);
  return parsePaycorPostingDateFromJobId(cleanPaycorText(jobIdMatch?.[1] || ""));
}

function parsePaycorPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return { postings: [], validBoard: false, hasNoJobsState: false };

  const lower = source.toLowerCase();
  const hasNoJobsState = lower.includes('id="gnewtonnoactivejobs"');
  const validBoard =
    lower.includes("recruitingbypaycor.com/career") ||
    lower.includes('id="gnewtoncareerbody"') ||
    lower.includes("gnewtoncareergrouprowclass");
  if (!validBoard) {
    return { postings: [], validBoard: false, hasNoJobsState };
  }
  if (hasNoJobsState) {
    return { postings: [], validBoard: true, hasNoJobsState: true };
  }

  const postings = [];
  const seenUrls = new Set();
  const anchorPattern = /<a[^>]*href=["']([^"']*JobIntroduction\.action[^"']*)["'][^>]*(?:ns-qa=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch = anchorPattern.exec(source);
  while (anchorMatch) {
    const href = cleanPaycorText(anchorMatch[1] || "");
    const titleFromNsqa = cleanPaycorText(anchorMatch[2] || "");
    const titleFromLabel = cleanPaycorText(anchorMatch[3] || "");
    let postingUrl = "";
    try {
      postingUrl = new URL(href, pageUrl).toString();
    } catch {
      postingUrl = "";
    }

    if (!postingUrl || seenUrls.has(postingUrl)) {
      anchorMatch = anchorPattern.exec(source);
      continue;
    }

    const nextRowIndex = source.indexOf('<div class="gnewtonCareerGroupRowClass">', anchorMatch.index + 1);
    const nextHeaderIndex = source.indexOf('<div class="gnewtonCareerGroupHeaderClass">', anchorMatch.index + 1);
    const rowEndIndexCandidates = [nextRowIndex, nextHeaderIndex]
      .filter((value) => Number.isInteger(value) && value > anchorMatch.index)
      .sort((a, b) => a - b);
    const rowEndIndex = rowEndIndexCandidates.length ? rowEndIndexCandidates[0] : Math.min(source.length, anchorMatch.index + 8000);
    const rowHtml = source.slice(anchorMatch.index, rowEndIndex);
    const location = extractPaycorLocationFromHtml(rowHtml);

    const inlineDateMatch = rowHtml.match(
      /(?:Date\s*Posted|Posted\s*Date|Posting\s*Date|Posted)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i
    );
    let postingDate = null;
    if (inlineDateMatch?.[1]) {
      const parsedEpoch = parsePostingDateToEpochSeconds(cleanPaycorText(inlineDateMatch[1]), nowEpochSeconds());
      if (parsedEpoch) postingDate = new Date(parsedEpoch * 1000).toISOString();
    }

    postings.push({
      company_name: String(companyNameForPostings || "").trim() || "Unknown Company",
      position_name: titleFromNsqa || titleFromLabel || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: postingDate,
      location: location || null
    });
    seenUrls.add(postingUrl);
    anchorMatch = anchorPattern.exec(source);
  }

  return { postings, validBoard: true, hasNoJobsState: false };
}

module.exports = { collectPostingsForPaycorCompany, parsePaycorCompany };
