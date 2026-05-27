let db = null;
let syncPromise = null;
let postingLocationByJobUrl = new Map();
let syncEnabledAts = new Set();
let syncDownloadJobDescriptions = true;
const ATS_REQUEST_QUEUE_CONCURRENCY_RAW = Number(process.env.ATS_REQUEST_QUEUE_CONCURRENCY || 1);
const ATS_REQUEST_QUEUE_CONCURRENCY_DEFAULT =
  Number.isFinite(ATS_REQUEST_QUEUE_CONCURRENCY_RAW) && ATS_REQUEST_QUEUE_CONCURRENCY_RAW > 0
    ? Math.floor(ATS_REQUEST_QUEUE_CONCURRENCY_RAW)
    : 1;

let atsRequestQueueConcurrency = ATS_REQUEST_QUEUE_CONCURRENCY_DEFAULT;

function getDb() {
  return db;
}

function getSyncPromise() {
  return syncPromise;
}

function getPostingLocationByJobUrl() {
  return postingLocationByJobUrl;
}

function setDb(nextDb) {
  db = nextDb;
}

function setSyncPromise(nextSyncPromise) {
  syncPromise = nextSyncPromise;
  return syncPromise
}

function setPostingLocationByJobUrl(nextPostingLocationByJobUrl) {
  postingLocationByJobUrl = nextPostingLocationByJobUrl;
  return postingLocationByJobUrl;
}

function getSyncEnabledAts() {
  return syncEnabledAts;
}

function setSyncEnabledAts(nextSyncEnabledAts) {
  syncEnabledAts = nextSyncEnabledAts;
  return syncEnabledAts;
}

function getSyncDownloadJobDescriptions() {
  return syncDownloadJobDescriptions;
}

function setSyncDownloadJobDescriptions(nextSyncDownloadJobDescriptions) {
  syncDownloadJobDescriptions = nextSyncDownloadJobDescriptions;
  return syncDownloadJobDescriptions;
}

function getAtsRequestQueueConcurrency() {
  return atsRequestQueueConcurrency;
}

function setAtsRequestQueueConcurrency(nextAtsRequestQueueConcurrency) {
  atsRequestQueueConcurrency = nextAtsRequestQueueConcurrency;
  return atsRequestQueueConcurrency;
}

module.exports = {
  getDb,
  setDb,
  getSyncPromise,
  setSyncPromise,
  getPostingLocationByJobUrl,
  setPostingLocationByJobUrl,
  getSyncEnabledAts,
  setSyncEnabledAts,
  getSyncDownloadJobDescriptions,
  setSyncDownloadJobDescriptions,
  getAtsRequestQueueConcurrency,
  setAtsRequestQueueConcurrency,
  ATS_REQUEST_QUEUE_CONCURRENCY_DEFAULT
};
