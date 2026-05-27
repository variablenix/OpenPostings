const { parseUrl, decodeHtmlEntities } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const TALENTLYFT_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;


async function collectPostingsForTalentlyftCompany(company) {
  const config = parseTalentlyftCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.subdomainLower;
  const { pageHtml: landingHtml, finalUrl } = await fetchTalentlyftLandingPage(config.careersUrl);
  const initialConfig = extractTalentlyftInitialConfig(landingHtml, finalUrl || config.careersUrl);

  const finalParsed = parseUrl(finalUrl);
  const baseOrigin = `${finalParsed?.protocol || "https:"}//${finalParsed?.host || config.host}`;
  const runtimeConfig = {
    ...config,
    ...initialConfig,
    baseOrigin,
    websiteUrl: String(initialConfig?.websiteUrl || baseOrigin).replace(/\/+$/, ""),
    apiUrl: String(initialConfig?.apiUrl || `${baseOrigin}/JobList/`).replace(/\/+$/, "") + "/"
  };

  const collected = [];
  const seenUrls = new Set();
  let totalPages = 1;

  for (let page = 1; page <= Math.min(MAX_PAGES_PER_COMPANY, totalPages); page += 1) {
    const fragmentHtml = await fetchTalentlyftJobListFragment(runtimeConfig, page, 20);
    const batch = parseTalentlyftPostingsFromFragment(companyNameForPostings, runtimeConfig, fragmentHtml);

    for (const posting of batch) {
      const postingUrl = String(posting?.job_posting_url || "").trim();
      if (!postingUrl || seenUrls.has(postingUrl)) continue;
      seenUrls.add(postingUrl);
      collected.push(posting);
    }

    totalPages = Math.max(totalPages, extractTalentlyftTotalPages(fragmentHtml));
    if (batch.length === 0 && page >= totalPages) break;
  }

  return collected;
}

function parseTalentlyftCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".talentlyft.com")) return null;

  const [subdomain = ""] = host.split(".");
  if (!subdomain) return null;

  return {
    host,
    subdomain,
    subdomainLower: subdomain.toLowerCase(),
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    careersUrl: `${parsed.protocol}//${parsed.host}/`
  };
}


function cleanTalentlyftText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTalentlyftInitialConfig(pageHtml, fallbackUrl) {
  const source = String(pageHtml || "");
  const parsed = parseUrl(fallbackUrl);
  const websiteUrlDefault = parsed ? `${parsed.protocol}//${parsed.host}` : "";
  const subdomainDefault = parsed ? String(parsed.hostname || "").split(".")[0] : "";

  const pickFirst = (patterns) => {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) return String(match[1]).trim();
    }
    return "";
  };

  const layoutId = pickFirst([/layoutId\s*:\s*['"]([^'"]+)['"]/i, /layoutId\s*=\s*['"]([^'"]+)['"]/i]) || "Jobs-1";
  const themeId = pickFirst([/themeId\s*:\s*['"]([^'"]+)['"]/i, /themeId\s*=\s*['"]([^'"]+)['"]/i]) || "2";
  const language = pickFirst([/language\s*:\s*['"]([^'"]+)['"]/i, /language\s*=\s*['"]([^'"]+)['"]/i]) || "en";
  const subdomain =
    pickFirst([/subdomain\s*:\s*['"]([^'"]+)['"]/i, /subdomain\s*=\s*['"]([^'"]+)['"]/i]) || subdomainDefault;
  const websiteUrl =
    pickFirst([/websiteUrl\s*:\s*['"]([^'"]+)['"]/i, /websiteUrl\s*=\s*['"]([^'"]+)['"]/i]) || websiteUrlDefault;

  return {
    layoutId,
    themeId,
    language,
    subdomain,
    websiteUrl,
    apiUrl: websiteUrl ? `${websiteUrl}/JobList/` : ""
  };
}

function extractTalentlyftTotalPages(fragmentHtml) {
  const source = String(fragmentHtml || "");
  const matches = Array.from(source.matchAll(/data-page=['"](\d+)['"]/gi));
  const pages = matches
    .map((match) => Number(match?.[1] || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return pages.length > 0 ? Math.max(...pages) : 1;
}

function parseTalentlyftPostingsFromFragment(companyNameForPostings, config, fragmentHtml) {
  const source = String(fragmentHtml || "");
  const postings = [];
  const seenUrls = new Set();
  const itemPattern =
    /<a[^>]*class=['"][^'"]*\bjobs__box\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;

  let itemMatch = itemPattern.exec(source);
  while (itemMatch) {
    const blockHtml = String(itemMatch[0] || "");
    const bodyHtml = String(itemMatch[1] || "");

    const href = String(blockHtml.match(/\bhref=['"]([^'"]+)['"]/i)?.[1] || "").trim();
    const absoluteUrl = href ? new URL(href, `${config.baseOrigin || ""}/`).toString() : "";
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
      itemMatch = itemPattern.exec(source);
      continue;
    }

    const id =
      String(blockHtml.match(/\bdata-job-id=['"](\d+)['"]/i)?.[1] || "").trim() ||
      String(blockHtml.match(/\bid=['"](\d+)['"]/i)?.[1] || "").trim() ||
      absoluteUrl;
    const title = cleanTalentlyftText(bodyHtml.match(/<h3[^>]*class=['"][^'"]*\bjobs__box__heading\b[^'"]*['"][^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "");
    const location = cleanTalentlyftText(bodyHtml.match(/<p[^>]*class=['"][^'"]*\bjobs__box__text\b[^'"]*['"][^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");

    postings.push({
      company_name: companyNameForPostings,
      position_name: title || "Untitled Position",
      job_posting_url: absoluteUrl,
      posting_date: null,
      location: location || null
    });
    seenUrls.add(absoluteUrl);
    itemMatch = itemPattern.exec(source);
  }

  return postings;
}



async function fetchTalentlyftLandingPage(urlString) {
  const res = await fetchWithAtsRateLimit("talentlyft", TALENTLYFT_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Talentlyft landing page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const finalUrl = String(res.url || urlString || "").trim();
  const finalHost = String(parseUrl(finalUrl)?.hostname || "").toLowerCase();
  if (!finalHost.endsWith(".talentlyft.com")) {
    throw new Error(`Talentlyft URL redirected to unexpected host: ${finalUrl}`);
  }

  return { pageHtml: await res.text(), finalUrl };
}

async function fetchTalentlyftJobListFragment(config, page = 1, pageSize = 20) {
  const apiUrl = String(config?.apiUrl || "").trim();
  if (!apiUrl) {
    throw new Error("Talentlyft API URL is missing");
  }

  const params = new URLSearchParams({
    layoutId: String(config?.layoutId || "Jobs-1"),
    websiteUrl: String(config?.websiteUrl || ""),
    themeId: String(config?.themeId || "2"),
    language: String(config?.language || "en"),
    subdomain: String(config?.subdomain || ""),
    page: String(page),
    pageSize: String(pageSize),
    contains: ""
  }).toString();
  const url = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}${params}`;

  const res = await fetchWithAtsRateLimit("talentlyft", TALENTLYFT_RATE_LIMIT_WAIT_MS, url, {
    method: "GET",
    headers: {
      Accept: "text/html, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      Referer: `${String(config?.websiteUrl || "").replace(/\/+$/, "")}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Talentlyft JobList request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

module.exports = { collectPostingsForTalentlyftCompany, parseTalentlyftCompany };