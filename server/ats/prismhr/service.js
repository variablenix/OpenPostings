
const { parseUrl, stripHtml, urljoin, extractCompanyNameFromUrlString, toCleanString, decodeHtmlEntities, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { parsePostingDateToEpochSeconds, nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const PRISMHR_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForPrismhrCompany(company) {
  const config = parsePrismhrCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings =
    normalizedCompanyName || extractCompanyNameFromUrlString(config.host) || config.host;

  const boardRes = await fetchWithAtsRateLimit("prismhr", PRISMHR_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    method: "GET",
    headers: { "User-Agent": DEFAULT_BROWSER_USER_AGENT }
  });
  if (!boardRes.ok) {
    const body = await boardRes.text();
    throw new Error(`PrismHR board request failed (${boardRes.status}): ${body.slice(0, 180)}`);
  }

  const finalBoardUrl = String(boardRes.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalBoardUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".prismhr-hire.com") || finalHost === "login.prismhr-hire.com") {
    return [];
  }

  const boardHtml = await boardRes.text();
  const postings = parsePrismhrPostingsFromHtml(companyNameForPostings, boardHtml, finalBoardUrl);
  if (!Array.isArray(postings) || postings.length === 0) return [];

  const referenceEpoch = nowEpochSeconds();
  const syncFallbackPostingDateIso = new Date(referenceEpoch * 1000).toISOString();
  for (const posting of postings) {
    const postingUrl = String(posting?.job_posting_url || "").trim();
    if (!postingUrl) continue;
    let postingDate = String(posting?.posting_date || "").trim();
    try {
      const detailRes = await fetchWithAtsRateLimit("prismhr", PRISMHR_RATE_LIMIT_WAIT_MS, postingUrl, {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_BROWSER_USER_AGENT,
          Referer: finalBoardUrl
        }
      });
      if (!detailRes.ok) continue;
      const detailHtml = await detailRes.text();
      const extractedPostingDate = String(extractPrismhrPostingDateFromDetailHtml(detailHtml) || "").trim();
      if (extractedPostingDate) {
        postingDate = extractedPostingDate;
      }
    } catch {
      // Keep listing posting even if detail page is temporarily unavailable.
    }

    if (!postingDate || !shouldStorePostingByDate(postingDate, referenceEpoch)) {
      postingDate = syncFallbackPostingDateIso;
    }
    posting.posting_date = postingDate;
  }

  return postings;
}

function parsePrismhrCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".prismhr-hire.com")) return null;
  if (host === "prismhr-hire.com" || host === "www.prismhr-hire.com" || host === "login.prismhr-hire.com") {
    return null;
  }

  const baseOrigin = `${parsed.protocol}//${parsed.host}`;
  return {
    host,
    boardUrl: `${baseOrigin}/`
  };
}


function extractPrismhrPostingDateFromDetailHtml(detailHtml) {
  const source = String(detailHtml || "");
  if (!source) return null;

  const patterns = [
    /"datePosted"\s*:\s*"([^"]+)"/i,
    /"datePublished"\s*:\s*"([^"]+)"/i
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

function extractPrismhrLocationMapFromReactProps(sourceHtml) {
  const source = String(sourceHtml || "");
  if (!source) return new Map();

  const match = source.match(
    /data-react-class=["']HiringThing\.Components\.JobFiltersContainer["'][^>]*data-react-props=["']([\s\S]*?)["']/i
  );
  const encodedProps = String(match?.[1] || "").trim();
  if (!encodedProps) return new Map();

  let props;
  try {
    props = JSON.parse(decodeHtmlEntities(encodedProps));
  } catch {
    return new Map();
  }

  const locationByJobId = new Map();
  const locations = props?.locations;
  if (locations && typeof locations === "object") {
    for (const [stateOrRegion, citiesValue] of Object.entries(locations)) {
      if (!citiesValue || typeof citiesValue !== "object") continue;
      for (const [city, jobIds] of Object.entries(citiesValue)) {
        if (!Array.isArray(jobIds)) continue;
        const cityLabel = toCleanString(city);
        const stateLabel = toCleanString(stateOrRegion);
        const locationLabel = [cityLabel, stateLabel].filter(Boolean).join(", ");
        if (!locationLabel) continue;
        for (const jobId of jobIds) {
          const key = String(jobId || "").trim();
          if (!key) continue;
          if (!locationByJobId.has(key)) {
            locationByJobId.set(key, locationLabel);
          }
        }
      }
    }
  }

  const remotePositions = Array.isArray(props?.remotePositions) ? props.remotePositions : [];
  for (const jobId of remotePositions) {
    const key = String(jobId || "").trim();
    if (!key) continue;
    if (!locationByJobId.has(key)) {
      locationByJobId.set(key, "Remote");
    }
  }

  return locationByJobId;
}

function parsePrismhrPostingsFromHtml(companyNameForPostings, pageHtml, pageUrl) {
  const source = String(pageHtml || "");
  if (!source) return [];

  const lower = source.toLowerCase();
  const hasBoardMarker =
    (lower.includes('id="career-opportunities"') || lower.includes("career opportunities")) &&
    lower.includes('data-react-class="hiringthing.components.jobfilterscontainer"');
  if (!hasBoardMarker) return [];

  if (lower.includes("no open positions at this time")) return [];

  const locationByJobId = extractPrismhrLocationMapFromReactProps(source);
  const postings = [];
  const seenUrls = new Set();
  const blockRegex =
    /<div[^>]*class=["'][^"']*\bjob-container\b[^"']*["'][^>]*data-job-id=["'](?<jobId>\d+)["'][^>]*>(?<block>[\s\S]*?)<\/div>\s*<\/div>/gi;
  const linkRegex =
    /<a[^>]*href=["'](?<href>\/job\/\d+\/[^"']+)["'][^>]*>\s*<h2>(?<title>[\s\S]*?)<\/h2>/i;
  const locationRegex =
    /<div[^>]*class=["'][^"']*\bjob-location\b[^"']*["'][^>]*>(?<location>[\s\S]*?)<\/div>/i;

  let match = blockRegex.exec(source);
  while (match) {
    const block = String(match.groups?.block || "");
    const jobId = String(match.groups?.jobId || "").trim();
    const linkMatch = linkRegex.exec(block);
    if (!linkMatch) {
      match = blockRegex.exec(source);
      continue;
    }

    const href = decodeHtmlEntities(String(linkMatch.groups?.href || ""));
    const postingUrl = urljoin(pageUrl, href);
    if (!postingUrl || seenUrls.has(postingUrl)) {
      match = blockRegex.exec(source);
      continue;
    }

    const positionName = toCleanString(stripHtml(linkMatch.groups?.title || "")) || "Untitled Position";
    const inlineLocation = toCleanString(stripHtml(locationRegex.exec(block)?.groups?.location || ""));
    const location = inlineLocation || locationByJobId.get(jobId) || null;

    postings.push({
      company_name: companyNameForPostings,
      position_name: positionName,
      job_posting_url: postingUrl,
      posting_date: null,
      location
    });
    seenUrls.add(postingUrl);
    match = blockRegex.exec(source);
  }

  return postings;
}

module.exports = { collectPostingsForPrismhrCompany, parsePrismhrCompany };
