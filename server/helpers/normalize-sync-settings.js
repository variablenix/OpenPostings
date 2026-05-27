const { normalizeAtsRequestQueueConcurrency, ATS_REQUEST_QUEUE_CONCURRENCY_DEFAULT } = require("../services/queue.js");
const { normalizeSyncEnabledAts, SYNC_DEFAULT_ENABLED_ATS } = require("./normalize-ats.js");
const { normalizePostingFreshnessHours, normalizeBoolean, POSTING_FRESHNESS_HOURS_DEFAULT } = require("./normalize-numbers.js");

const SYNC_SERVICE_SETTINGS_DEFAULTS = {
  ats_request_queue_concurrency: ATS_REQUEST_QUEUE_CONCURRENCY_DEFAULT,
  sync_enabled_ats: SYNC_DEFAULT_ENABLED_ATS,
  posting_freshness_hours: POSTING_FRESHNESS_HOURS_DEFAULT,
  download_job_descriptions: true
};


function normalizeSyncServiceSettingsInput(value = {}, fallback = SYNC_SERVICE_SETTINGS_DEFAULTS) {
  /** @type {any} */
  const source = value && typeof value === "object" ? value : {};
  const fallbackConcurrency = normalizeAtsRequestQueueConcurrency(fallback?.ats_request_queue_concurrency);
  const fallbackEnabledAts = normalizeSyncEnabledAts(fallback?.sync_enabled_ats);
  const fallbackPostingFreshnessHours = normalizePostingFreshnessHours(fallback?.posting_freshness_hours);
  const fallbackDownloadJobDescriptions = normalizeBoolean(fallback?.download_job_descriptions, true);
  return {
    ats_request_queue_concurrency: normalizeAtsRequestQueueConcurrency(
      source.ats_request_queue_concurrency,
      fallbackConcurrency
    ),
    sync_enabled_ats: normalizeSyncEnabledAts(source.sync_enabled_ats, fallbackEnabledAts),
    posting_freshness_hours: normalizePostingFreshnessHours(
      source.posting_freshness_hours,
      fallbackPostingFreshnessHours
    ),
    download_job_descriptions: normalizeBoolean(
      source.download_job_descriptions,
      fallbackDownloadJobDescriptions
    )
  };
}

module.exports = { normalizeSyncServiceSettingsInput, SYNC_SERVICE_SETTINGS_DEFAULTS };
