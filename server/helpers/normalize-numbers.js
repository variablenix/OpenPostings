const { normalizeLikeText } = require("./normalize-strings.js");

const MIN_POSTING_FRESHNESS_HOURS = 24;
const MAX_POSTING_FRESHNESS_HOURS = 24 * 7;

const POSTING_TTL_SECONDS_FALLBACK = Number(process.env.POSTING_TTL_SECONDS || 24 * 60 * 60);

const POSTING_FRESHNESS_HOURS_DEFAULT = (() => {
  const envHours = Number(process.env.POSTING_FRESHNESS_HOURS);
  const fromHours = Number.isFinite(envHours) && envHours > 0 ? Math.floor(envHours) : 0;
  const fromLegacySeconds =
  Number.isFinite(POSTING_TTL_SECONDS_FALLBACK) && POSTING_TTL_SECONDS_FALLBACK > 0
  ? Math.max(1, Math.round(POSTING_TTL_SECONDS_FALLBACK / 3600))
  : 24;
  const base = fromHours || fromLegacySeconds || 24;
  return Math.max(MIN_POSTING_FRESHNESS_HOURS, Math.min(MAX_POSTING_FRESHNESS_HOURS, base));
})();

let postingFreshnessHours = POSTING_FRESHNESS_HOURS_DEFAULT;

function getPostingFreshnessHours() {
  return postingFreshnessHours;
}

function setPostingFreshnessHours(value) {
  const normalized = normalizePostingFreshnessHours(value);
  postingFreshnessHours = normalized;
  return postingFreshnessHours;
}


function parseNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getPostingFreshnessWindowSeconds() {
  return normalizePostingFreshnessHours(postingFreshnessHours) * 60 * 60;
}


function normalizePostingFreshnessHours(value, fallbackValue = POSTING_FRESHNESS_HOURS_DEFAULT) {
  const fallbackParsed = parsePositiveInteger(fallbackValue) || POSTING_FRESHNESS_HOURS_DEFAULT;
  const parsed = parsePositiveInteger(value) || fallbackParsed;
  return Math.max(MIN_POSTING_FRESHNESS_HOURS, Math.min(MAX_POSTING_FRESHNESS_HOURS, parsed));
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeLikeText(value);
  if (!normalized) return Boolean(defaultValue);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}


function parsePostingDateToEpochSeconds(postingDate, referenceEpoch = nowEpochSeconds()) {
  const raw = String(postingDate ?? "").trim();
  if (!raw) return null;

  const normalizedLower = raw.toLowerCase();
  if (normalizedLower === "new" || normalizedLower === "just now" || normalizedLower === "now") {
    return Number(referenceEpoch);
  }
  if (normalizedLower === "posted today" || normalizedLower === "today") {
    return Number(referenceEpoch);
  }
  if (normalizedLower === "posted yesterday" || normalizedLower === "yesterday") {
    return Number(referenceEpoch) - 24 * 60 * 60;
  }

  const daysAgoMatch = normalizedLower.match(/^(\d+)\s+day(?:s)?\s+ago$/i);
  if (daysAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(daysAgoMatch[1]) * 24 * 60 * 60;
  }
  const shortDaysAgoMatch = normalizedLower.match(/^(\d+)\s*d$/i);
  if (shortDaysAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(shortDaysAgoMatch[1]) * 24 * 60 * 60;
  }

  const hoursAgoMatch = normalizedLower.match(/^(\d+)\s+hour(?:s)?\s+ago$/i);
  if (hoursAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(hoursAgoMatch[1]) * 60 * 60;
  }
  const shortHoursAgoMatch = normalizedLower.match(/^(\d+)\s*h$/i);
  if (shortHoursAgoMatch?.[1]) {
    return Number(referenceEpoch) - Number(shortHoursAgoMatch[1]) * 60 * 60;
  }

  // Relative ranges seen in some ATS feeds (e.g., "3 months", "about 19 hours", "almost 2 years").
  const relativeUnitMatch = normalizedLower.match(
    /^(?:(about|over|almost)\s+)?(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)$/i
  );
  if (relativeUnitMatch?.[2] && relativeUnitMatch?.[3]) {
    const modifier = String(relativeUnitMatch[1] || "").toLowerCase();
    const amountRaw = Number(relativeUnitMatch[2]);
    const unit = String(relativeUnitMatch[3] || "").toLowerCase();
    if (Number.isFinite(amountRaw) && amountRaw >= 0) {
      let amount = amountRaw;
      if (modifier === "almost") amount = Math.max(0, amount - 0.2);
      if (modifier === "over") amount += 0.2;

      let unitSeconds = 0;
      if (unit.startsWith("minute")) unitSeconds = 60;
      else if (unit.startsWith("hour")) unitSeconds = 60 * 60;
      else if (unit.startsWith("day")) unitSeconds = 24 * 60 * 60;
      else if (unit.startsWith("week")) unitSeconds = 7 * 24 * 60 * 60;
      else if (unit.startsWith("month")) unitSeconds = 30 * 24 * 60 * 60;
      else if (unit.startsWith("year")) unitSeconds = 365 * 24 * 60 * 60;

      if (unitSeconds > 0) {
        return Number(referenceEpoch) - Math.floor(amount * unitSeconds);
      }
    }
  }

  let normalized = raw
    .replace(/^posted\s+/i, "")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (/^\d{10,13}$/.test(normalized)) {
    const numericEpoch = Number(normalized.length === 13 ? Math.floor(Number(normalized) / 1000) : normalized);
    if (Number.isFinite(numericEpoch) && numericEpoch > 0) {
      return numericEpoch;
    }
  }

  const parsedMs = Date.parse(normalized);
  if (Number.isFinite(parsedMs)) return Math.floor(parsedMs / 1000);

  // Month/day labels without year should be interpreted against the current year.
  const monthDayMatch = normalized.match(/^[a-z]{3,9}\s+\d{1,2}$/i);
  if (monthDayMatch) {
    const referenceYear = new Date(Number(referenceEpoch) * 1000).getUTCFullYear();
    let candidateMs = Date.parse(`${normalized} ${referenceYear}`);
    if (Number.isFinite(candidateMs)) {
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (candidateMs > Number(referenceEpoch) * 1000 + oneDayMs) {
        const previousYearCandidateMs = Date.parse(`${normalized} ${referenceYear - 1}`);
        if (Number.isFinite(previousYearCandidateMs)) candidateMs = previousYearCandidateMs;
      }
      return Math.floor(candidateMs / 1000);
    }
  }

  normalized = normalized.replace(/,\s*/g, " ").trim();
  const fallbackParsedMs = Date.parse(normalized);
  if (Number.isFinite(fallbackParsedMs)) return Math.floor(fallbackParsedMs / 1000);

  return null;
}

function shouldStorePostingByDate(postingDate, referenceEpoch = nowEpochSeconds()) {
  const raw = String(postingDate ?? "").trim();
  if (!raw) return true;

  const parsedEpoch = parsePostingDateToEpochSeconds(raw, referenceEpoch);
  if (!parsedEpoch) return false;
  return parsedEpoch >= Number(referenceEpoch) - getPostingFreshnessWindowSeconds();
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}


function normalizePayFilterNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

module.exports = { POSTING_FRESHNESS_HOURS_DEFAULT, MIN_POSTING_FRESHNESS_HOURS, MAX_POSTING_FRESHNESS_HOURS, getPostingFreshnessHours, setPostingFreshnessHours, parseNonNegativeInteger, getPostingFreshnessWindowSeconds, normalizePostingFreshnessHours, normalizeBoolean, parsePositiveInteger, shouldStorePostingByDate, parsePostingDateToEpochSeconds, nowEpochSeconds, normalizePayFilterNumber };
