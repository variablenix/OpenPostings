const WORKDAY_PAGE_SIZE = 20;
const MAX_WORKDAY_PAGES_PER_COMPANY = 25;
const WORKDAY_RATE_LIMIT_WAIT_MS = 60 * 1000;
const LOCALE_SEGMENT_REGEX = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const { getPostingFreshnessWindowSeconds, normalizeBoolean } = require("../../helpers/normalize-numbers.js");
const { cleanHtmlText } = require("../../helpers/normalize-strings.js");
const { normalizeCompensationType, normalizeEducationLevels } = require("../../helpers/description-filters.js");
const { fetchWithAtsRateLimit } = require("../../services/queue.js");

// Getting today's job postings for a given company
async function collectPostingsForWorkdayCompany(company, options = {}) {
  const config = parseWorkdayCompany(company?.url_string);
  if (!config) return [];

  const shouldDownloadDescriptions = normalizeBoolean(options?.downloadJobDescriptions, true);
  const detailBaseUrl = String(config.cxsUrl || "").replace(/\/jobs\/?$/i, "");
  const collected = [];
  const maxFreshnessDays = Math.max(1, Math.ceil(getPostingFreshnessWindowSeconds() / (24 * 60 * 60)));
  let offset = 0;

  for (let page = 0; page < MAX_WORKDAY_PAGES_PER_COMPANY; page += 1) {
    const response = await fetchWorkdayPage(config.cxsUrl, WORKDAY_PAGE_SIZE, offset);
    const postings = Array.isArray(response?.jobPostings) ? response.jobPostings : [];
    if (postings.length === 0) break;

    let inWindowOnPage = 0;
    for (const posting of postings) {
      if (!isWithinPostingFreshnessWindow(posting?.postedOn, maxFreshnessDays)) continue;
      inWindowOnPage += 1;

      const externalPath = String(posting?.externalPath || "").trim();
      const normalizedExternalPath = externalPath ? (externalPath.startsWith("/") ? externalPath : `/${externalPath}`) : "";
      const jobUrl = normalizedExternalPath ? `${config.companyBaseUrl}${normalizedExternalPath}` : "";
      if (!jobUrl) continue;

      let jobDescription = null;
      let compensationType = "unknown";
      let educationLevels = [];
      let payMin = null;
      let payMax = null;
      let payCurrency = null;
      let payPeriod = null;
      let payRaw = null;
      // Description fetch is optional; compensation/education extraction depends on this payload.
      if (shouldDownloadDescriptions && normalizedExternalPath && detailBaseUrl) {
        const detailUrl = `${detailBaseUrl}${normalizedExternalPath}`;
        try {
          const detailResponse = await fetchWithAtsRateLimit("workday", WORKDAY_RATE_LIMIT_WAIT_MS, detailUrl, {
            method: "GET",
            headers: {
              Accept: "application/json"
            }
          });
          if (detailResponse.ok) {
            const detailPayload = await detailResponse.json();
            const descriptionValue = String(detailPayload?.jobPostingInfo?.jobDescription || "").trim();
            jobDescription = cleanHtmlText(descriptionValue) || null;
            const parsedDescriptionFilters = parseWorkdayDescriptionFilters(descriptionValue);
            compensationType = parsedDescriptionFilters.compensation_type;
            educationLevels = parsedDescriptionFilters.education_levels;
            payMin = parsedDescriptionFilters.pay_min;
            payMax = parsedDescriptionFilters.pay_max;
            payCurrency = parsedDescriptionFilters.pay_currency;
            payPeriod = parsedDescriptionFilters.pay_period;
            payRaw = parsedDescriptionFilters.pay_raw;
          }
        } catch {
          jobDescription = null;
          compensationType = "unknown";
          educationLevels = [];
          payMin = null;
          payMax = null;
          payCurrency = null;
          payPeriod = null;
          payRaw = null;
        }
      }

      collected.push({
        company_name: company.company_name,
        position_name: String(posting?.title || "").trim() || "Untitled Position",
        job_posting_url: jobUrl,
        posting_date: String(posting?.postedOn || "").trim() || null,
        job_description: jobDescription,
        compensation_type: compensationType,
        education_levels: educationLevels,
        pay_min: payMin,
        pay_max: payMax,
        pay_currency: payCurrency,
        pay_period: payPeriod,
        pay_raw: payRaw
      });
    }

    if (inWindowOnPage === 0 || postings.length < WORKDAY_PAGE_SIZE) break;
    offset += WORKDAY_PAGE_SIZE;
  }

  return collected;
}

// Filtering out postings that are older than our configured freshness window.
function isWithinPostingFreshnessWindow(postedOn, maxFreshnessDays) {
  const normalized = String(postedOn || "").trim().toLowerCase();
  if (!normalized) return false;

  if (normalized === "posted today" || normalized === "today") return true;
  if (normalized === "posted yesterday" || normalized === "yesterday") return maxFreshnessDays >= 1;

  const exactDaysMatch = normalized.match(/^posted\s+(\d+)\s+day(?:s)?\s+ago$/);
  if (exactDaysMatch?.[1]) {
    return Number(exactDaysMatch[1]) <= maxFreshnessDays;
  }

  const exactDaysNoPrefixMatch = normalized.match(/^(\d+)\s+day(?:s)?\s+ago$/);
  if (exactDaysNoPrefixMatch?.[1]) {
    return Number(exactDaysNoPrefixMatch[1]) <= maxFreshnessDays;
  }

  const plusDaysMatch = normalized.match(/^posted\s+(\d+)\+\s+day(?:s)?\s+ago$/);
  if (plusDaysMatch?.[1]) {
    return false;
  }

  const plusDaysNoPrefixMatch = normalized.match(/^(\d+)\+\s+day(?:s)?\s+ago$/);
  if (plusDaysNoPrefixMatch?.[1]) {
    return false;
  }

  return false;
}

// Parsing Workday description text into normalized compensation + education filter fields.
function parseWorkdayDescriptionFilters(jobDescription) {
  const normalizedDescription = normalizeDescriptionForSignals(jobDescription);
  const compensationDetails = extractWorkdayCompensationDetails(jobDescription);
  if (!normalizedDescription) {
    return {
      compensation_type: "unknown",
      education_levels: [],
      pay_min: compensationDetails.pay_min,
      pay_max: compensationDetails.pay_max,
      pay_currency: compensationDetails.pay_currency,
      pay_period: compensationDetails.pay_period,
      pay_raw: compensationDetails.pay_raw
    };
  }

  const hasHourlySignal =
    /\bhourly\b/.test(normalizedDescription) ||
    /\bper\s*hour\b/.test(normalizedDescription) ||
    /\/\s*hr\b/.test(normalizedDescription);
  const hasSalarySignal =
    /\bsalary\b/.test(normalizedDescription) ||
    /\bannual(?:ly)?\b/.test(normalizedDescription) ||
    /\bper\s*year\b/.test(normalizedDescription) ||
    /\/\s*year\b/.test(normalizedDescription) ||
    /\byearly\b/.test(normalizedDescription);

  let compensationType = "unknown";
  if (hasHourlySignal && hasSalarySignal) {
    compensationType = "both";
  } else if (hasHourlySignal) {
    compensationType = "hourly";
  } else if (hasSalarySignal) {
    compensationType = "salary";
  } else if (compensationDetails.pay_period === "hour") {
    compensationType = "hourly";
  } else if (compensationDetails.pay_period === "year") {
    compensationType = "salary";
  }

  const detectedEducationLevels = [];
  if (/\b(high school|ged)\b/.test(normalizedDescription)) {
    detectedEducationLevels.push("high_school");
  }
  if (/\bassociate(?:s)?\b/.test(normalizedDescription)) {
    detectedEducationLevels.push("associate");
  }
  if (
    /\bbachelor(?:s)?\b/.test(normalizedDescription) ||
    /\bb\.?\s*s\.?\b/.test(normalizedDescription) ||
    /\bb\.?\s*a\.?\b/.test(normalizedDescription)
  ) {
    detectedEducationLevels.push("bachelor");
  }
  if (
    /\bmaster(?:s)?\b/.test(normalizedDescription) ||
    /\bmba\b/.test(normalizedDescription) ||
    /\bm\.?\s*s\.?\b/.test(normalizedDescription) ||
    /\bm\.?\s*a\.?\b/.test(normalizedDescription)
  ) {
    detectedEducationLevels.push("master");
  }
  if (/\b(doctorate|doctoral|phd|ph\.d\.)\b/.test(normalizedDescription)) {
    detectedEducationLevels.push("doctorate");
  }
  if (/\b(certificate|certification|certified|diploma)\b/.test(normalizedDescription)) {
    detectedEducationLevels.push("certificate");
  }

  return {
    compensation_type: normalizeCompensationType(compensationType, "unknown"),
    education_levels: normalizeEducationLevels(detectedEducationLevels),
    pay_min: compensationDetails.pay_min,
    pay_max: compensationDetails.pay_max,
    pay_currency: compensationDetails.pay_currency,
    pay_period: compensationDetails.pay_period,
    pay_raw: compensationDetails.pay_raw
  };
}

// Normalizing description text for broad keyword checks (hourly/salary/education terms).
function normalizeDescriptionForSignals(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Extracting best-effort compensation details from Workday description content.
function extractWorkdayCompensationDetails(jobDescription) {
  const plainText = normalizeDescriptionForCompensationParsing(jobDescription);
  if (!plainText) {
    return {
      pay_min: null,
      pay_max: null,
      pay_currency: null,
      pay_period: null,
      pay_raw: null
    };
  }

  const candidateSegments = extractCompensationCandidateSegments(plainText);
  for (const segment of candidateSegments) {
    const parsed = parseCompensationFromSegment(segment);
    if (!parsed) continue;
    return parsed;
  }

  const fallbackParsed = parseCompensationFromSegment(plainText);
  if (fallbackParsed) return fallbackParsed;

  return {
    pay_min: null,
    pay_max: null,
    pay_currency: null,
    pay_period: null,
    pay_raw: null
  };
}

// Narrowing parsing scope to likely compensation lines before full-text fallback.
function extractCompensationCandidateSegments(plainText) {
  const lines = String(plainText || "")
    .split(/\n+/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    if (!looksLikeCompensationLine(line)) continue;
    candidates.push(line);
  }

  return candidates;
}

// Quick pre-filter to avoid parsing every line as compensation.
function looksLikeCompensationLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  return /(\$|\u20ac|\u00a3|\u00a5|usd|cad|aud|eur|gbp|jpy|salary|compensation|pay|wage|hourly|annual|per\s+hour|per\s+year)/i.test(
    text
  );
}

// Parsing one line/segment for pay range, min-only, max-only, or exact pay values.
function parseCompensationFromSegment(segment) {
  const text = String(segment || "").trim();
  if (!text) return null;

  const moneyTokenPattern =
    "(?:USD|CAD|AUD|EUR|GBP|JPY|NZD|CHF|SEK|NOK|DKK|INR)?\\s*(?:[$\\u20AC\\u00A3\\u00A5])?\\s*(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?\\s*(?:[kKmM])?";

  const rangeRegex = new RegExp(`(${moneyTokenPattern})\\s*(?:-|\\u2013|\\u2014|to)\\s*(${moneyTokenPattern})`, "i");
  const maxOnlyRegex = new RegExp(
    `(?:up\\s*to|max(?:imum)?\\s*(?:of)?|no\\s*more\\s*than)\\s*(${moneyTokenPattern})`,
    "i"
  );
  const minOnlyRegex = new RegExp(`(?:from|starting\\s*at|minimum\\s*(?:of)?|at\\s*least)\\s*(${moneyTokenPattern})`, "i");
  const exactRegex = new RegExp(
    `\\b(?:pay|salary|compensation|wage|rate)\\b\\s*(?:range)?\\s*[:\\-]?\\s*(${moneyTokenPattern})(?!\\s*(?:-|\\u2013|\\u2014|to))`,
    "i"
  );

  const period = detectCompensationPeriod(text);

  // Range pattern: "$50,000 - $80,000", "20 to 24", etc.
  const rangeMatch = text.match(rangeRegex);
  if (rangeMatch) {
    const currency = detectCompensationCurrency(rangeMatch[0]);
    const minValueRaw = parseCompensationAmount(rangeMatch[1]);
    const maxValueRaw = parseCompensationAmount(rangeMatch[2]);
    const minValue = isLikelyCompensationAmountValue(minValueRaw, rangeMatch[1], text, period, currency)
      ? minValueRaw
      : null;
    const maxValue = isLikelyCompensationAmountValue(maxValueRaw, rangeMatch[2], text, period, currency)
      ? maxValueRaw
      : null;
    if (minValue !== null || maxValue !== null) {
      const payMin = minValue !== null && maxValue !== null ? Math.min(minValue, maxValue) : minValue;
      const payMax = minValue !== null && maxValue !== null ? Math.max(minValue, maxValue) : maxValue;
      return {
        pay_min: payMin,
        pay_max: payMax,
        pay_currency: currency,
        pay_period: period,
        pay_raw: rangeMatch[0].trim()
      };
    }
  }

  // Max-only pattern: "up to $90,000".
  const maxOnlyMatch = text.match(maxOnlyRegex);
  if (maxOnlyMatch) {
    const currency = detectCompensationCurrency(maxOnlyMatch[0]);
    const maxValueRaw = parseCompensationAmount(maxOnlyMatch[1]);
    const maxValue = isLikelyCompensationAmountValue(maxValueRaw, maxOnlyMatch[1], text, period, currency)
      ? maxValueRaw
      : null;
    if (maxValue !== null) {
      return {
        pay_min: null,
        pay_max: maxValue,
        pay_currency: currency,
        pay_period: period,
        pay_raw: maxOnlyMatch[0].trim()
      };
    }
  }

  // Min-only pattern: "starting at $25/hr".
  const minOnlyMatch = text.match(minOnlyRegex);
  if (minOnlyMatch) {
    const currency = detectCompensationCurrency(minOnlyMatch[0]);
    const minValueRaw = parseCompensationAmount(minOnlyMatch[1]);
    const minValue = isLikelyCompensationAmountValue(minValueRaw, minOnlyMatch[1], text, period, currency)
      ? minValueRaw
      : null;
    if (minValue !== null) {
      return {
        pay_min: minValue,
        pay_max: null,
        pay_currency: currency,
        pay_period: period,
        pay_raw: minOnlyMatch[0].trim()
      };
    }
  }

  // Exact pattern: "salary: $70,000", "pay rate 23 per hour".
  const exactMatch = text.match(exactRegex);
  if (exactMatch) {
    const currency = detectCompensationCurrency(exactMatch[0]);
    const exactValueRaw = parseCompensationAmount(exactMatch[1]);
    const exactValue = isLikelyCompensationAmountValue(exactValueRaw, exactMatch[1], text, period, currency)
      ? exactValueRaw
      : null;
    if (exactValue !== null) {
      return {
        pay_min: exactValue,
        pay_max: exactValue,
        pay_currency: currency,
        pay_period: period,
        pay_raw: exactMatch[0].trim()
      };
    }
  }

  return null;
}

// Converting a money token to a numeric amount and handling k/m suffixes.
function parseCompensationAmount(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return null;

  const withoutCurrency = token
    .replace(/\b(?:USD|CAD|AUD|EUR|GBP|JPY|NZD|CHF|SEK|NOK|DKK|INR)\b/gi, "")
    .replace(/[$€£¥]/g, "")
    .replace(/\s+/g, "")
    .replace(/,/g, "");
  if (!withoutCurrency) return null;

  const suffixMatch = withoutCurrency.match(/[kKmM]$/);
  const suffix = suffixMatch ? suffixMatch[0].toLowerCase() : "";
  const numericPart = suffix ? withoutCurrency.slice(0, -1) : withoutCurrency;
  const parsed = Number(numericPart);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  if (suffix === "k") return Math.round(parsed * 1000);
  if (suffix === "m") return Math.round(parsed * 1000000);
  return parsed;
}

// Detecting whether a token explicitly carries a currency signal.
function hasCompensationCurrencySignal(rawToken) {
  const token = String(rawToken || "");
  if (!token) return false;
  if (/[$\u20AC\u00A3\u00A5]/.test(token)) return true;
  return /\b(?:USD|CAD|AUD|EUR|GBP|JPY|NZD|CHF|SEK|NOK|DKK|INR)\b/i.test(token);
}

// Detecting signals that make a bare number look like real compensation.
function hasCompensationScaleSignal(rawToken, numericValue) {
  const token = String(rawToken || "");
  if (/[kKmM]\b/.test(token)) return true;
  if (/\d{1,3}(?:,\d{3})+/.test(token)) return true;
  return Number.isFinite(numericValue) && numericValue >= 1000;
}

// Rejecting common non-pay false positives like 401(k).
function isRetirementPlanReference(rawToken, segmentText, numericValue) {
  const token = String(rawToken || "");
  const segment = String(segmentText || "");
  if (/\b401\s*(?:\(\s*k\s*\)|k\b)/i.test(token)) return true;
  if (Number(numericValue) === 401 && /\b401\s*(?:\(\s*k\s*\)|k\b)/i.test(segment)) return true;
  return false;
}

// Guardrail to avoid storing numbers that are unlikely to be compensation.
function isLikelyCompensationAmountValue(value, rawToken, segmentText, period, currency) {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (isRetirementPlanReference(rawToken, segmentText, value)) return false;

  const hasCurrencySignal = Boolean(currency) || hasCompensationCurrencySignal(rawToken);
  const hasPeriodSignal = Boolean(period);
  const hasScaleSignal = hasCompensationScaleSignal(rawToken, value);

  return hasCurrencySignal || hasPeriodSignal || hasScaleSignal;
}

// Inferring canonical currency code from symbols or ISO currency abbreviations.
function detectCompensationCurrency(text) {
  const source = String(text || "");
  const codeMatch = source.match(/\b(USD|CAD|AUD|EUR|GBP|JPY|NZD|CHF|SEK|NOK|DKK|INR)\b/i);
  if (codeMatch?.[1]) return codeMatch[1].toUpperCase();

  if (source.includes("€")) return "EUR";
  if (source.includes("£")) return "GBP";
  if (source.includes("¥")) return "JPY";
  if (source.includes("$")) return "USD";
  return null;
}

// Inferring pay period from language like "per hour", "annual", "/yr", etc.
function detectCompensationPeriod(text) {
  const source = String(text || "").toLowerCase();
  if (!source) return null;

  if (/(per\s*hour|an?\s*hour|hourly|\/\s*hr|\/\s*hour)/i.test(source)) return "hour";
  if (/(per\s*week|weekly|\/\s*wk|\/\s*week)/i.test(source)) return "week";
  if (/(per\s*month|monthly|\/\s*mo|\/\s*month)/i.test(source)) return "month";
  if (/(per\s*year|annually|annual|yearly|\/\s*yr|\/\s*year)/i.test(source)) return "year";

  return null;
}

// Normalizing Workday HTML-ish description into line-preserving plain text.
function normalizeDescriptionForCompensationParsing(value) {
  return String(value || "")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Fetching the job postings data
async function fetchWorkdayPage(cxsUrl, limit, offset) {
  const res = await fetchWithAtsRateLimit("workday", WORKDAY_RATE_LIMIT_WAIT_MS, cxsUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      appliedFacets: {},
      limit,
      offset,
      searchText: ""
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Workday request failed (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}

// Extracting location info from the job posting url
function inferWorkdayLocationFromJobUrl(jobPostingUrl) {
  try {
    const parsed = new URL(String(jobPostingUrl || ""));
    const pathParts = parsed.pathname
      .split("/")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    const jobIndex = pathParts.findIndex((part) => part.toLowerCase() === "job");
    if (jobIndex >= 0 && pathParts[jobIndex + 1] && pathParts[jobIndex + 2]) {
      const rawLocation = decodeURIComponent(pathParts[jobIndex + 1]);
      const trimmed = String(rawLocation || "").trim();
      if (!trimmed) return null;
      const doubleDashToken = "__DOUBLE_DASH__";
      return trimmed
        .replace(/--+/g, doubleDashToken)
        .replace(/-/g, " ")
        .replace(new RegExp(doubleDashToken, "g"), "- ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return null;
  } catch {
    return null;
  }
}

// Extracting company info from the url
function parseWorkdayCompany(urlString) {
  let parsed = null;
  try {
    parsed = new URL(String(urlString || "").trim());
  } catch {
    parsed = null;
  }
  if (!parsed) return null;

  const [subdomain = ""] = parsed.hostname.split(".");
  const pathParts = parsed.pathname
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const first = String(pathParts[0] || "").trim();
  const second = String(pathParts[1] || "").trim();
  const companyIdRaw = first && LOCALE_SEGMENT_REGEX.test(first) && second ? second : first || subdomain;
  const companyIdApi = companyIdRaw.toLowerCase();

  if (!subdomain || !companyIdApi) return null;

  return {
    subdomain: subdomain.toLowerCase(),
    companyIdRaw,
    companyIdApi,
    companyBaseUrl: `${parsed.origin}/${companyIdRaw}`,
    cxsUrl: `${parsed.origin}/wday/cxs/${subdomain.toLowerCase()}/${companyIdApi}/jobs`
  };
}


// Understanding the url structure
function parseWorkdaySeededCompanySource(urlString) {
  let parsed = null;
  try {
    parsed = new URL(String(urlString || "").trim());
  } catch {
    parsed = null;
  }
  const host = String(parsed?.hostname || "").toLowerCase();
  if (!host.endsWith("myworkdayjobs.com")) return null;
  return parseWorkdayCompany(urlString);
}

module.exports = { collectPostingsForWorkdayCompany, fetchWorkdayPage, inferWorkdayLocationFromJobUrl, parseWorkdayCompany, parseWorkdaySeededCompanySource };
