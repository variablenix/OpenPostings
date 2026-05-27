const { decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { nowEpochSeconds, shouldStorePostingByDate } = require("../../helpers/normalize-numbers")
const { fetchWithAtsRateLimit } = require("../../services/queue");
const CALCAREERS_ESTIMATED_COMPANY_COUNT = 297;
const CALCAREERS_RATE_LIMIT_WAIT_MS = 60 * 1000;

function cleanCalcareersText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCalcareersHiddenInputs(htmlSource) {
  const source = String(htmlSource || "");
  const hidden = {};
  const regex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let match = regex.exec(source);
  while (match) {
    const tag = String(match[0] || "");
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
    if (!nameMatch?.[1]) {
      match = regex.exec(source);
      continue;
    }
    const valueMatch = tag.match(/\bvalue=["']([^"']*)["']/i);
    hidden[nameMatch[1]] = valueMatch?.[1] || "";
    match = regex.exec(source);
  }
  return hidden;
}

function extractCalcareersPagerTargets(htmlSource) {
  const source = String(htmlSource || "");
  const targets = [];
  const seen = new Set();
  const regex = /__doPostBack\(&#39;([^']+btnPagerItem[^']*)&#39;,\s*&#39;[^']*&#39;\)/gi;
  let match = regex.exec(source);
  while (match) {
    const target = String(match[1] || "").trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
    match = regex.exec(source);
  }
  return targets;
}

function parseCalcareersPostingsFromHtml(htmlSource) {
  const source = String(htmlSource || "");
  if (!source) return [];

  const postings = [];
  const seenUrls = new Set();
  const cardRegex = new RegExp(
    String.raw`Working Title:\s*</div>\s*<div class="col-xs-6 job-details">\s*<span[^>]*>(.*?)</span>` +
      String.raw`[\s\S]*?Job Control:\s*</div>\s*<div class="col-xs-6 job-details">\s*(\d+)\s*</div>` +
      String.raw`[\s\S]*?Department:\s*</div>\s*<div class="col-xs-6 job-details">\s*(.*?)\s*</div>` +
      String.raw`[\s\S]*?Location:\s*</div>\s*<div class="col-xs-6 job-details">\s*(.*?)\s*</div>` +
      String.raw`[\s\S]*?Publish Date:\s*</div>\s*<div class="col-xs-6 job-details">\s*<time[^>]*>\s*([^<]+)\s*</time>` +
      String.raw`[\s\S]*?href="(https:\/\/www\.calcareers\.ca\.gov\/CalHrPublic\/Jobs\/JobPosting\.aspx\?JobControlId=\d+)"`,
    "gi"
  );

  let match = cardRegex.exec(source);
  while (match) {
    const positionName = cleanCalcareersText(match[1]) || "Untitled Position";
    const companyName = cleanCalcareersText(match[3]) || "Unknown Department";
    const location = cleanCalcareersText(match[4]) || null;
    const postingDate = cleanCalcareersText(match[5]) || null;
    const jobPostingUrl = cleanCalcareersText(match[6]);
    if (!jobPostingUrl || seenUrls.has(jobPostingUrl)) {
      match = cardRegex.exec(source);
      continue;
    }
    postings.push({
      company_name: companyName,
      position_name: positionName,
      job_posting_url: jobPostingUrl,
      posting_date: postingDate,
      location
    });
    seenUrls.add(jobPostingUrl);
    match = cardRegex.exec(source);
  }

  return postings;
}

function buildCalcareersPostPayload(hiddenFields, eventTarget) {
  const payload = { ...(hiddenFields || {}) };
  payload.__EVENTTARGET = eventTarget;
  payload.__EVENTARGUMENT = "";
  payload["ctl00$cphMainContent$txtKeyword"] = "";
  payload["ctl00$cphMainContent$chkExactWordMatch"] = "on";
  payload["ctl00$cphMainContent$hdnInit"] = "true";
  payload["ctl00$ucUtilityHeader1$txtGoogleSiteSearch"] = payload["ctl00$ucUtilityHeader1$txtGoogleSiteSearch"] || "";
  payload["ctl00$hdnShowHeaderPadding"] = payload["ctl00$hdnShowHeaderPadding"] || "1";
  payload["ctl00$ucSessionTimeoutDialog$tmrCountdown"] = payload["ctl00$ucSessionTimeoutDialog$tmrCountdown"] || "1200";
  return payload;
}

async function collectPostingsForCalcareersDynamic() {
  const endpoint = "https://calcareers.ca.gov/CalHRPublic/Search/JobSearchResults.aspx";
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: endpoint
  };
  const referenceEpoch = nowEpochSeconds();
  const postings = [];
  const seenUrls = new Set();
  const pendingTargets = [];
  const visitedTargets = new Set();

  const landing = await fetchWithAtsRateLimit("calcareers", CALCAREERS_RATE_LIMIT_WAIT_MS, endpoint, {
    method: "GET",
    headers
  });
  if (!landing.ok) {
    const body = await landing.text();
    throw new Error(`CalCareers landing request failed (${landing.status}): ${body.slice(0, 180)}`);
  }

  let hidden = extractCalcareersHiddenInputs(await landing.text());
  let nextEventTarget = "ctl00$cphMainContent$btnSearch";
  let rowCountApplied = false;

  while (true) {
    const payload = buildCalcareersPostPayload(hidden, nextEventTarget);
    if (nextEventTarget === "ctl00$cphMainContent$ddlRowCount") {
      payload["ctl00$cphMainContent$ddlRowCount"] = "100";
    }

    const res = await fetchWithAtsRateLimit("calcareers", CALCAREERS_RATE_LIMIT_WAIT_MS, endpoint, {
      method: "POST",
      headers,
      body: new URLSearchParams(payload).toString()
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CalCareers postback failed (${res.status}): ${body.slice(0, 180)}`);
    }
    const pageHtml = await res.text();
    hidden = extractCalcareersHiddenInputs(pageHtml);

    const batch = parseCalcareersPostingsFromHtml(pageHtml);
    let hasWithin24h = false;
    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      if (!shouldStorePostingByDate(posting?.posting_date, referenceEpoch)) continue;
      postings.push(posting);
      seenUrls.add(postingUrl);
      hasWithin24h = true;
    }

    if (!rowCountApplied) {
      rowCountApplied = true;
      nextEventTarget = "ctl00$cphMainContent$ddlRowCount";
      continue;
    }

    if (!hasWithin24h) break;

    const pagerTargets = extractCalcareersPagerTargets(pageHtml);
    for (const target of pagerTargets) {
      if (visitedTargets.has(target)) continue;
      if (!pendingTargets.includes(target)) {
        pendingTargets.push(target);
      }
    }
    while (pendingTargets.length > 0 && visitedTargets.has(pendingTargets[0])) {
      pendingTargets.shift();
    }
    if (pendingTargets.length === 0) break;

    nextEventTarget = pendingTargets.shift();
    visitedTargets.add(nextEventTarget);
  }

  return postings;
}

module.exports = { collectPostingsForCalcareersDynamic, CALCAREERS_ESTIMATED_COMPANY_COUNT };