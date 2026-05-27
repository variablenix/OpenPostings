const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const HIREBRIDGE_RATE_LIMIT_WAIT_MS = 60 * 1000;

async function collectPostingsForHirebridgeCompany(company) {
  const config = parseHirebridgeCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || `hirebridge_${config.cid}`;
  const { pageHtml, finalUrl } = await fetchHirebridgeJobsPage(config);
  const finalParsed = parseUrl(finalUrl);
  const parseConfig = {
    ...config,
    baseOrigin: `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`,
    boardUrl: finalUrl || config.boardUrl
  };

  const rawPostings = parseHirebridgePostingsFromHtml(companyNameForPostings, parseConfig, pageHtml);
  const collected = [];
  const seenUrls = new Set();

  for (const posting of rawPostings) {
    const postingUrl = String(posting?.job_posting_url || "").trim();
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    let postingDate = "";
    try {
      const detailsHtml = await fetchHirebridgeDetailsPage(parseConfig, postingUrl);
      postingDate = String(extractHirebridgeDatePostedFromDetailHtml(detailsHtml) || "").trim();
    } catch {
      continue;
    }
    if (!postingDate) continue;

    collected.push({
      ...posting,
      posting_date: postingDate
    });
    seenUrls.add(postingUrl);
  }

  return collected;
}

function parseHirebridgeCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "recruit.hirebridge.com" && host !== "www.recruit.hirebridge.com") return null;

  const cid = String(parsed.searchParams?.get("cid") || "").trim();
  if (!cid) return null;

  return {
    host,
    cid,
    boardUrl: `https://recruit.hirebridge.com/v3/jobs/list.aspx?cid=${encodeURIComponent(cid)}`,
    detailsBaseUrl: "https://recruit.hirebridge.com/v3/CareerCenter/v2/details.aspx"
  };
}

function cleanHirebridgeText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseHirebridgePostingsFromHtml(companyNameForPostings, config, pageHtml) {
  const source = String(pageHtml || "");
  const postings = [];
  const seenUrls = new Set();

  const itemPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const sectionPattern =
    /<div[^>]*class=["'][^"']*\brow\b[^"']*["'][^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<\/div>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\brow\b[^"']*["'][^>]*>\s*<h2\b|$)/gi;
  const linkPattern =
    /<a[^>]*href=["']([^"']*\/v3\/Jobs\/JobDetails\.aspx\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
  const departmentPattern = /<span[^>]*class=["'][^"']*\bdepartment\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;

  const appendItemsFromChunk = (chunkHtml, sectionLocation = "") => {
    const normalizedLocation = cleanHirebridgeText(sectionLocation);
    let itemMatch = itemPattern.exec(chunkHtml);
    while (itemMatch) {
      const itemHtml = String(itemMatch[1] || "");
      const linkMatch = itemHtml.match(linkPattern);
      const hrefRaw = String(linkMatch?.[1] || "").trim();
      const href = decodeHtmlEntities(hrefRaw).replace(/\s+/g, "");
      let absoluteUrl = "";
      if (href) {
        try {
          absoluteUrl = new URL(href, `${config.baseOrigin || ""}/`).toString();
        } catch {
          absoluteUrl = "";
        }
      }
      if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
        itemMatch = itemPattern.exec(chunkHtml);
        continue;
      }

      const title = cleanHirebridgeText(linkMatch?.[2] || "") || "Untitled Position";
      const department = cleanHirebridgeText(itemHtml.match(departmentPattern)?.[1] || "");

      postings.push({
        company_name: companyNameForPostings,
        position_name: title,
        job_posting_url: absoluteUrl,
        posting_date: null,
        location: normalizedLocation || department || null,
        department: department || null
      });

      seenUrls.add(absoluteUrl);
      itemMatch = itemPattern.exec(chunkHtml);
    }
  };

  let sectionMatch = sectionPattern.exec(source);
  let sectionCount = 0;
  while (sectionMatch) {
    const sectionLocation = String(sectionMatch[1] || "");
    const sectionBody = String(sectionMatch[2] || "");
    appendItemsFromChunk(sectionBody, sectionLocation);
    sectionCount += 1;
    sectionMatch = sectionPattern.exec(source);
  }

  if (sectionCount === 0) {
    appendItemsFromChunk(source, "");
  }

  return postings;
}

function extractHirebridgeDatePostedFromDetailHtml(pageHtml) {
  const source = String(pageHtml || "");
  const patterns = [
    /"datePosted"\s*:\s*"([^"]+)"/i,
    /["']dateposted["']\s*:\s*["']([^"']+)["']/i,
    /itemprop=["']datePosted["'][^>]*content=["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const value = String(source.match(pattern)?.[1] || "").trim();
    if (value) return value;
  }

  return null;
}

function buildHirebridgeDetailsUrl(config, jobPostingUrl) {
  const parsed = parseUrl(jobPostingUrl);
  if (!parsed) return "";

  const jid = String(parsed.searchParams?.get("jid") || "").trim();
  const cid = String(parsed.searchParams?.get("cid") || config?.cid || "").trim();
  if (!jid || !cid) return "";

  return `${config.detailsBaseUrl}?cid=${encodeURIComponent(cid)}&jid=${encodeURIComponent(jid)}`;
}

async function fetchHirebridgeJobsPage(config) {
  const res = await fetchWithAtsRateLimit("hirebridge", HIREBRIDGE_RATE_LIMIT_WAIT_MS, config.boardUrl, {
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
    throw new Error(`Hirebridge page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || config.boardUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "recruit.hirebridge.com" && finalHost !== "www.recruit.hirebridge.com") {
    throw new Error(`Hirebridge URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

async function fetchHirebridgeDetailsPage(config, jobPostingUrl) {
  const detailsUrl = buildHirebridgeDetailsUrl(config, jobPostingUrl);
  if (!detailsUrl) return "";

  const res = await fetchWithAtsRateLimit("hirebridge", HIREBRIDGE_RATE_LIMIT_WAIT_MS, detailsUrl, {
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
    throw new Error(`Hirebridge details request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || detailsUrl || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (finalHost !== "recruit.hirebridge.com" && finalHost !== "www.recruit.hirebridge.com") {
    throw new Error(`Hirebridge details URL redirected to unexpected host: ${finalUrl}`);
  }

  return res.text();
}

module.exports = { collectPostingsForHirebridgeCompany, parseHirebridgeCompany };
