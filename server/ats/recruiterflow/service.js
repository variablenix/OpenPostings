

const { parseUrl, toCleanString, urljoin, extractCompanyNameFromUrlString, DEFAULT_BROWSER_USER_AGENT } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const RECRUITERFLOW_RATE_LIMIT_WAIT_MS = 60 * 1000;

function parseRecruiterflowCompany(url) {
  const parsed = parseUrl(url);
  if (!parsed?.host) return null;
  const host = String(parsed.host || "").toLowerCase();
  if (host !== "recruiterflow.com" && host !== "www.recruiterflow.com") return null;

  const pathParts = String(parsed.pathname || "")
    .split("/")
    .filter(Boolean);
  if (pathParts.length < 1) return null;
  const companySlug = pathParts[0];
  const protocol = parsed.protocol || "https:";
  const boardUrl = `${protocol}//${host}/${companySlug}/jobs`;
  return { host, boardUrl, companySlug };
}

function extractRecruiterflowJobsListObject(pageHtml) {
  const source = String(pageHtml || "");
  const marker = source.match(/window\.jobsList\s*=/i);
  if (!marker || marker.index === undefined) return null;
  const start = marker.index + marker[0].length;

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let begin = -1;
  for (let idx = start; idx < source.length; idx += 1) {
    const ch = source[idx];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "{") {
      if (begin === -1) begin = idx;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && begin !== -1) {
        const objectText = source.slice(begin, idx + 1);
        try {
          return JSON.parse(objectText);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseRecruiterflowPostingsFromHtml(companyNameForPostings, pageHtml) {
  const jobsList = extractRecruiterflowJobsListObject(pageHtml);
  if (!jobsList || typeof jobsList !== "object") return [];
  const departmentRows = Array.isArray(jobsList.department) ? jobsList.department : [];

  const postings = [];
  const seenUrls = new Set();
  for (const group of departmentRows) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const departmentName = toCleanString(group[0]);
    const jobs = Array.isArray(group[1]) ? group[1] : [];
    for (const job of jobs) {
      if (!job || typeof job !== "object") continue;
      const applyLink = toCleanString(job.apply_link);
      if (!applyLink) continue;
      const postingUrl = urljoin("https://recruiterflow.com/", applyLink);
      if (!postingUrl || seenUrls.has(postingUrl)) continue;

      postings.push({
        company_name: companyNameForPostings,
        position_name: toCleanString(job.job_name) || "Untitled Position",
        job_posting_url: postingUrl,
        posting_date: toCleanString(job.last_opened) || null,
        location: toCleanString(job.details) || null,
        employment_type: toCleanString(job.employment_type) || null,
        remote_type: toCleanString(job.remote_type) || null,
        department: departmentName || null
      });
      seenUrls.add(postingUrl);
    }
  }
  return postings;
}

async function collectPostingsForRecruiterflowCompany(company) {
  const config = parseRecruiterflowCompany(company.url_string);
  if (!config) return [];
  const companyNameForPostings =
    toCleanString(company.company_name) || extractCompanyNameFromUrlString(config.companySlug) || config.companySlug;

  const res = await fetchWithAtsRateLimit("recruiterflow", RECRUITERFLOW_RATE_LIMIT_WAIT_MS, config.boardUrl, {
    headers: {
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  return parseRecruiterflowPostingsFromHtml(companyNameForPostings, pageHtml);
}

module.exports = { collectPostingsForRecruiterflowCompany, parseRecruiterflowCompany };
