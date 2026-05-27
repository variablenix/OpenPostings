const { parseUrl, cleanText, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const isolved_RATE_LIMIT_WAIT_MS = 60 * 1000;


function parseisolvedCompany(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return null;

  const parsed = parseUrl(normalizedUrl);
  if (!parsed || !parsed.protocol || !parsed.host) return null;
  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".isolvedhire.com")) return null;

  return {
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    boardUrl: normalizedUrl,
    host
  };
}

function extractisolvedDomainId(pageHtml) {
  const page = String(pageHtml || "");
  const routeDataMatch = page.match(/courierCurrentRouteData\s*=\s*(\{[\s\S]*?\});/i);
  if (routeDataMatch) {
    try {
      const parsed = JSON.parse(routeDataMatch[1]);
      const domainId = cleanText(parsed?.domain_id);
      if (domainId) return domainId;
    } catch {}
  }

  const directMatch = page.match(/"domain_id"\s*:\s*"?(?<id>\d+)"?/i);
  if (directMatch?.groups?.id) return cleanText(directMatch.groups.id);
  return "";
}

async function fetchisolvedJobBoard(config) {
  const boardResponse = await fetchWithAtsRateLimit(
    "isolved",
    isolved_RATE_LIMIT_WAIT_MS,
    config.boardUrl,
    {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }
  );
  if (!boardResponse.ok) {
    const body = await boardResponse.text();
    throw new Error(`isolved board request failed (${boardResponse.status}): ${body.slice(0, 180)}`);
  }
  const boardHtml = await boardResponse.text();
  const domainId = extractisolvedDomainId(boardHtml);
  if (!domainId) throw new Error("isolved domain_id not found in board HTML");

  const apiUrl = `${config.baseOrigin}/core/jobs/${encodeURIComponent(domainId)}?getParams=%7B%7D`;
  const apiResponse = await fetchWithAtsRateLimit(
    "isolved",
    isolved_RATE_LIMIT_WAIT_MS,
    apiUrl,
    {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: config.boardUrl,
        Origin: config.baseOrigin
      }
    }
  );
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`isolved API request failed (${apiResponse.status}): ${body.slice(0, 180)}`);
  }
  return apiResponse.json();
}

function parseisolvedPostingsFromApi(companyName, responseJson) {
  if (!responseJson || typeof responseJson !== "object") return [];
  const jobs = Array.isArray(responseJson?.data?.jobs) ? responseJson.data.jobs : [];
  const postings = [];
  const seenUrls = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const postingUrl = cleanText(job.jobUrl) || "";
    if (!postingUrl || seenUrls.has(postingUrl)) continue;

    postings.push({
      company_name: companyName,
      position_name: cleanText(job.title) || "Untitled Position",
      job_posting_url: postingUrl,
      posting_date: cleanText(job.startDateRef) || null,
      location: cleanText(job.jobLocation) || null
    });
    seenUrls.add(postingUrl);
  }
  return postings;
}

async function collectPostingsForisolvedCompany(company) {
  const config = parseisolvedCompany(company?.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.host.split(".")[0];
  const responseJson = await fetchisolvedJobBoard(config);
  return parseisolvedPostingsFromApi(companyNameForPostings, responseJson);
}

module.exports = { collectPostingsForisolvedCompany, parseisolvedCompany };