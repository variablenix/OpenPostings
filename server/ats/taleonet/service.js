const { parseUrl } = require("../../helpers/normalize-strings");
const { fetchWithAtsRateLimit } = require("../../services/queue");
const TALEO_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PAGES_PER_COMPANY = 25;

async function fetchTaleoJobSearchPage(urlString) {
  const res = await fetchWithAtsRateLimit("taleo", TALEO_RATE_LIMIT_WAIT_MS, urlString, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Taleo page request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}

async function fetchTaleoRestSearchResults(config, portal, tokenName, tokenValue, pageNo) {
  const apiUrl = `${config.baseOrigin}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(
    config.lang
  )}&portal=${encodeURIComponent(portal)}`;
  const payload = buildTaleoRestPayload(pageNo);

  const headers = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    tz: "GMT-07:00",
    tzname: "America/Los_Angeles"
  };
  if (tokenName && tokenValue) {
    headers[tokenName] = tokenValue;
  }

  const res = await fetchWithAtsRateLimit("taleo", TALEO_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Taleo REST request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

async function fetchTaleoAjaxSearchResults(config, csrfToken = "") {
  const apiUrl = `${config.baseSectionUrl}/jobsearch.ajax`;
  const payload = new URLSearchParams(buildTaleoAjaxPayload(config.lang, csrfToken)).toString();

  const res = await fetchWithAtsRateLimit("taleo", TALEO_RATE_LIMIT_WAIT_MS, apiUrl, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      tz: "GMT-07:00",
      tzname: "America/Los_Angeles"
    },
    body: payload
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Taleo AJAX request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.text();
}




async function collectPostingsForTaleoCompany(company) {
  const config = parseTaleoCompany(company.url_string);
  if (!config) return [];

  const normalizedCompanyName = String(company?.company_name || "").trim();
  const companyNameForPostings = normalizedCompanyName || config.careerSectionLower;
  const pageHtml = await fetchTaleoJobSearchPage(company.url_string);
  const { portal, tokenName, tokenValue } = extractTaleoRestConfig(pageHtml);
  const postings = [];
  const seenUrls = new Set();

  if (portal) {
    for (let pageNo = 1; pageNo <= MAX_PAGES_PER_COMPANY; pageNo += 1) {
      const response = await fetchTaleoRestSearchResults(config, portal, tokenName, tokenValue, pageNo);
      const requisitions = Array.isArray(response?.requisitionList) ? response.requisitionList : [];
      if (requisitions.length === 0) break;

      const batch = extractTaleoPostingsFromRest(companyNameForPostings, config, requisitions);
      for (const posting of batch) {
        if (seenUrls.has(posting.job_posting_url)) continue;
        seenUrls.add(posting.job_posting_url);
        postings.push(posting);
      }

      const pagingData = response?.pagingData && typeof response.pagingData === "object" ? response.pagingData : {};
      const totalCount = Number(pagingData?.totalCount);
      const pageSizeRaw = Number(pagingData?.pageSize);
      const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : requisitions.length;
      if (requisitions.length < pageSize) break;
      if (Number.isFinite(totalCount) && pageNo * pageSize >= totalCount) break;
    }
  }

  if (postings.length > 0) {
    return postings;
  }

  const ajaxText = await fetchTaleoAjaxSearchResults(config, tokenValue);
  const ajaxPostings = extractTaleoPostingsFromAjax(companyNameForPostings, config, ajaxText);
  for (const posting of ajaxPostings) {
    if (seenUrls.has(posting.job_posting_url)) continue;
    seenUrls.add(posting.job_posting_url);
    postings.push(posting);
  }

  return postings;
}


function parseTaleoCompany(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return null;

  const host = String(parsed.hostname || "").toLowerCase();
  if (!host.endsWith(".taleo.net")) return null;

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  if (pathParts.length < 2 || pathParts[0].toLowerCase() !== "careersection") return null;

  const careerSection = pathParts[1];
  if (!careerSection) return null;

  const lang = String(parsed.searchParams.get("lang") || "en").trim() || "en";

  return {
    careerSection,
    careerSectionLower: careerSection.toLowerCase(),
    lang,
    baseOrigin: `${parsed.protocol}//${parsed.host}`,
    baseSectionUrl: `${parsed.protocol}//${parsed.host}/careersection/${careerSection}`
  };
}

function extractTaleoRestConfig(pageHtml) {
  const source = String(pageHtml || "");
  const portalMatch = source.match(/portal=([0-9]{6,})/i);
  const portal = String(portalMatch?.[1] || "").trim();

  const tokenNamePatterns = [
    /sessionCSRFTokenName\s*:\s*'([^']+)'/i,
    /sessionCSRFTokenName\s*:\s*"([^"]+)"/i,
    /"sessionCSRFTokenName"\s*:\s*"([^"]+)"/i,
    /name=['"](csrftoken)['"]/i
  ];
  const tokenValuePatterns = [
    /sessionCSRFToken\s*:\s*'([^']+)'/i,
    /sessionCSRFToken\s*:\s*"([^"]+)"/i,
    /"sessionCSRFToken"\s*:\s*"([^"]+)"/i,
    /name=["']csrftoken["'][^>]*value=["']([^"']+)["']/i
  ];

  let tokenName = "";
  let tokenValue = "";

  for (const pattern of tokenNamePatterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    tokenName = String(match[1] || "").trim();
    if (tokenName) break;
  }

  for (const pattern of tokenValuePatterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    tokenValue = String(match[1] || "").trim();
    if (tokenValue) break;
  }

  return { portal, tokenName, tokenValue };
}


function buildTaleoRestPayload(pageNo = 1) {
  return {
    multilineEnabled: true,
    sortingSelection: {
      sortBySelectionParam: "1",
      ascendingSortingOrder: "false"
    },
    fieldData: {
      fields: {
        LOCATION: "",
        CATEGORY: "",
        KEYWORD: ""
      },
      valid: true
    },
    filterSelectionParam: {
      searchFilterSelections: [
        { id: "JOB_FIELD", selectedValues: [] },
        { id: "LOCATION", selectedValues: [] },
        { id: "ORGANIZATION", selectedValues: [] },
        { id: "JOB_LEVEL", selectedValues: [] }
      ]
    },
    advancedSearchFiltersSelectionParam: {
      searchFilterSelections: [
        { id: "ORGANIZATION", selectedValues: [] },
        { id: "LOCATION", selectedValues: [] },
        { id: "JOB_FIELD", selectedValues: [] },
        { id: "JOB_NUMBER", selectedValues: [] },
        { id: "URGENT_JOB", selectedValues: [] },
        { id: "JOB_SHIFT", selectedValues: [] }
      ]
    },
    pageNo: Number(pageNo || 1)
  };
}

function buildTaleoAjaxPayload(lang = "en", csrfToken = "") {
  const payload = {
    ftlpageid: "reqListBasicPage",
    ftlinterfaceid: "requisitionListInterface",
    ftlcompid: "validateTimeZoneId",
    jsfCmdId: "validateTimeZoneId",
    ftlcompclass: "InitTimeZoneAction",
    ftlcallback: "requisition_restoreDatesValues",
    ftlajaxid: "ftlx1",
    tz: "GMT-07:00",
    tzname: "America/Los_Angeles",
    lang: String(lang || "en").trim() || "en",
    isExternal: "true",
    "rlPager.currentPage": "1",
    "listRequisition.size": "25",
    dropListSize: "25"
  };

  if (csrfToken) {
    payload.csrftoken = String(csrfToken || "").trim();
  }

  return payload;
}

function extractTaleoLocationLabel(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const normalized = parsed.map((item) => String(item || "").trim()).filter(Boolean);
        if (normalized.length > 0) return normalized.join(" / ");
      }
    } catch {
      // Fall through to the raw string value.
    }
  }

  return text;
}

function extractTaleoUnpostingDateFromRestColumns(columns) {
  const source = Array.isArray(columns) ? columns : [];
  const unpostingDate = String(source[4] || "").trim();
  return unpostingDate || null;
}

function extractTaleoPostingsFromRest(companyNameForPostings, config, requisitions) {
  const items = Array.isArray(requisitions) ? requisitions : [];
  const postings = [];

  for (const requisition of items) {
    const jobId = String(requisition?.jobId || requisition?.contestNo || "").trim();
    if (!jobId) continue;

    const columns = Array.isArray(requisition?.column) ? requisition.column : [];
    const title = String(columns[0] || "").trim() || "Untitled Position";
    const location = extractTaleoLocationLabel(columns[2] || "");
    const unpostingDate = extractTaleoUnpostingDateFromRestColumns(columns);
    const contestNo = String(requisition?.contestNo || "").trim();
    const detailRef = contestNo || jobId;
    const jobUrl = detailRef
      ? `${config.baseSectionUrl}/jobdetail.ftl?job=${encodeURIComponent(detailRef)}&lang=${encodeURIComponent(
          config.lang
        )}`
      : `${config.baseSectionUrl}/jobsearch.ftl?lang=${encodeURIComponent(config.lang)}`;

    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: jobUrl,
      posting_date: unpostingDate,
      location
    });
  }

  return postings;
}

function extractTaleoPostingsFromAjax(companyNameForPostings, config, ajaxText) {
  const source = String(ajaxText || "");
  if (!source.includes("!|!")) return [];

  const tokens = source.split("!|!");
  const applyPrefix = "Apply for this position (";
  const postings = [];
  const seenKeys = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const tokenText = String(tokens[index] || "").trim();
    if (!tokenText.startsWith(applyPrefix)) continue;

    let titleFromApply = tokenText.slice(applyPrefix.length).trim();
    if (titleFromApply.endsWith(")")) {
      titleFromApply = titleFromApply.slice(0, -1).trim();
    }

    const unpostingDate = index >= 2 ? String(tokens[index - 2] || "").trim() : "";
    const locationRaw = index >= 8 ? String(tokens[index - 8] || "").trim() : "";
    const jobNumber = index >= 9 ? String(tokens[index - 9] || "").trim() : "";
    let jobId = index >= 14 ? String(tokens[index - 14] || "").trim() : "";
    const fallbackTitle = index >= 13 ? String(tokens[index - 13] || "").trim() : "";

    if (!/^\d+$/.test(jobId)) {
      for (let step = 1; step <= 20; step += 1) {
        const candidate = String(tokens[index - step] || "").trim();
        if (/^\d+$/.test(candidate)) {
          jobId = candidate;
          break;
        }
      }
    }

    const title = titleFromApply || fallbackTitle || "Untitled Position";
    const detailRef = jobNumber || jobId;
    const location = extractTaleoLocationLabel(locationRaw);
    const dedupeKey = `${detailRef}|${title}|${location || ""}`.toLowerCase();
    if (!detailRef || seenKeys.has(dedupeKey)) continue;

    seenKeys.add(dedupeKey);
    postings.push({
      company_name: companyNameForPostings,
      position_name: title,
      job_posting_url: `${config.baseSectionUrl}/jobdetail.ftl?job=${encodeURIComponent(
        detailRef
      )}&lang=${encodeURIComponent(config.lang)}`,
      posting_date: unpostingDate || null,
      location
    });
  }

  return postings;
}


module.exports = { collectPostingsForTaleoCompany, parseTaleoCompany };
