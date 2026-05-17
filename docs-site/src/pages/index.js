import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Layout from "@theme/Layout";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./index.module.css";

function formatEpoch(epochSeconds) {
  const value = Number(epochSeconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Date(value * 1000).toLocaleString();
}

function formatPostingDate(postingDate, postingEpoch) {
  const dateText = String(postingDate || "").trim();
  if (dateText) return dateText;
  return formatEpoch(postingEpoch) || "Posting date unavailable";
}

const REMOTE_FILTER_OPTIONS = [
  { value: "all", label: "All Locations" },
  { value: "remote", label: "Remote Only" },
  { value: "hybrid", label: "Hybrid Only" },
  { value: "non_remote", label: "On-Site / Unknown" }
];

const COUNTRY_ALIAS_ENTRIES = [
  ["united states", "United States"],
  ["u.s.", "United States"],
  ["u.s.a.", "United States"],
  ["usa", "United States"],
  ["canada", "Canada"],
  ["united kingdom", "United Kingdom"],
  ["uk", "United Kingdom"],
  ["great britain", "United Kingdom"],
  ["australia", "Australia"],
  ["new zealand", "New Zealand"],
  ["germany", "Germany"],
  ["france", "France"],
  ["spain", "Spain"],
  ["italy", "Italy"],
  ["ireland", "Ireland"],
  ["india", "India"],
  ["singapore", "Singapore"],
  ["japan", "Japan"],
  ["mexico", "Mexico"],
  ["brazil", "Brazil"],
  ["netherlands", "Netherlands"],
  ["belgium", "Belgium"],
  ["sweden", "Sweden"],
  ["norway", "Norway"],
  ["denmark", "Denmark"],
  ["finland", "Finland"],
  ["switzerland", "Switzerland"],
  ["poland", "Poland"],
  ["austria", "Austria"],
  ["portugal", "Portugal"],
  ["south africa", "South Africa"]
];

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC"
]);

function inferRemoteModeFromLocation(locationText) {
  const normalized = String(locationText || "").trim().toLowerCase();
  if (!normalized) return "non_remote";
  if (normalized.includes("hybrid")) return "hybrid";
  if (normalized.includes("remote") || normalized.includes("work from home") || normalized.includes("wfh")) {
    return "remote";
  }
  return "non_remote";
}

function inferCountryFromLocation(locationText) {
  const raw = String(locationText || "").trim();
  if (!raw) return "Unknown";

  const normalized = raw.toLowerCase();
  for (const [needle, country] of COUNTRY_ALIAS_ENTRIES) {
    if (normalized.includes(needle)) return country;
  }

  const parts = raw
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const lastPart = parts.length > 0 ? parts[parts.length - 1] : "";
  const secondLast = parts.length > 1 ? parts[parts.length - 2] : "";

  if (US_STATE_CODES.has(String(lastPart).toUpperCase()) || US_STATE_CODES.has(String(secondLast).toUpperCase())) {
    return "United States";
  }

  return "Unknown";
}

function getCountryForItem(item) {
  const explicit = String(item?.country || "").trim();
  if (explicit) return explicit;
  return inferCountryFromLocation(item?.location);
}

function getRemoteModeForItem(item) {
  const explicit = String(item?.remote_mode || "").trim();
  if (explicit === "remote" || explicit === "hybrid" || explicit === "non_remote") return explicit;
  return inferRemoteModeFromLocation(item?.location);
}

function getRemoteModeLabel(value) {
  if (value === "remote") return "Remote";
  if (value === "hybrid") return "Hybrid";
  return "On-Site / Unknown";
}

function LoadingState() {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyTitle}>Loading OpenPostings Lite</div>
      <div className={styles.emptySubtitle}>Fetching latest chunk index...</div>
    </div>
  );
}

function ErrorState({ message }) {
  console.error(message)
  return (
    <div className={styles.emptyState} style={{ textAlign: "center" }}>
      <div className={styles.emptyTitle}>Could not load Lite dataset at this time.</div>
      <div className={styles.emptySubtitle}>Please try again later</div>
    </div>
  );
}

export default function Home() {
  const dataBaseUrl = useBaseUrl("lite-data/");
  const [meta, setMeta] = useState(null);
  const [loadedItems, setLoadedItems] = useState([]);
  const [loadedChunkCount, setLoadedChunkCount] = useState(0);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [loadingChunk, setLoadingChunk] = useState(false);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [atsFilter, setAtsFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [remoteFilter, setRemoteFilter] = useState("all");
  const loadMoreSentinelRef = useRef(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.classList.add("lite-homepage");
    return () => {
      document.body.classList.remove("lite-homepage");
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadIndex = async () => {
      try {
        setLoadingIndex(true);
        const response = await fetch(`${dataBaseUrl}index.json`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`index.json request failed (${response.status})`);
        }
        const payload = await response.json();
        if (cancelled) return;
        setMeta(payload);
      } catch (loadError) {
        if (cancelled) return;
        setError(String(loadError?.message || loadError));
      } finally {
        if (!cancelled) setLoadingIndex(false);
      }
    };
    loadIndex();
    return () => {
      cancelled = true;
    };
  }, [dataBaseUrl]);

  useEffect(() => {
    if (!meta || loadedChunkCount > 0) return;
    const firstChunkFile = Array.isArray(meta?.chunks) && meta.chunks[0]?.file ? meta.chunks[0].file : "";
    if (!firstChunkFile) return;

    let cancelled = false;
    const loadFirstChunk = async () => {
      try {
        setLoadingChunk(true);
        const response = await fetch(`${dataBaseUrl}${firstChunkFile}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`${firstChunkFile} request failed (${response.status})`);
        }
        const payload = await response.json();
        if (cancelled) return;
        setLoadedItems(Array.isArray(payload?.items) ? payload.items : []);
        setLoadedChunkCount(1);
      } catch (loadError) {
        if (cancelled) return;
        setError(String(loadError?.message || loadError));
      } finally {
        if (!cancelled) setLoadingChunk(false);
      }
    };
    loadFirstChunk();
    return () => {
      cancelled = true;
    };
  }, [meta, loadedChunkCount, dataBaseUrl]);

  const hasMoreChunks = useMemo(() => {
    const totalChunks = Number(meta?.total_chunks || 0);
    return loadedChunkCount < totalChunks;
  }, [loadedChunkCount, meta]);

  const atsOptions = useMemo(() => {
    const values = new Set();
    for (const item of loadedItems) {
      const ats = String(item?.ats || "").trim();
      if (ats) values.add(ats);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [loadedItems]);

  const countryOptions = useMemo(() => {
    const values = new Set();
    for (const item of loadedItems) {
      const country = getCountryForItem(item);
      if (country && country !== "Unknown") values.add(country);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [loadedItems]);

  const locationOptions = useMemo(() => {
    const values = new Set();
    for (const item of loadedItems) {
      const location = String(item?.location || "").trim();
      if (!location) continue;
      const country = getCountryForItem(item);
      if (countryFilter !== "all" && country !== countryFilter) continue;
      values.add(location);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [countryFilter, loadedItems]);

  const filteredItems = useMemo(() => {
    const query = String(searchQuery || "").trim().toLowerCase();
    return loadedItems.filter((item) => {
      const matchesAts = atsFilter === "all" || String(item?.ats || "").trim() === atsFilter;
      if (!matchesAts) return false;
      const itemCountry = getCountryForItem(item);
      if (countryFilter !== "all" && itemCountry !== countryFilter) return false;
      const itemLocation = String(item?.location || "").trim();
      if (locationFilter !== "all" && itemLocation !== locationFilter) return false;
      const itemRemoteMode = getRemoteModeForItem(item);
      if (remoteFilter !== "all" && itemRemoteMode !== remoteFilter) return false;
      if (!query) return true;
      const company = String(item?.company_name || "").toLowerCase();
      const title = String(item?.position_name || "").toLowerCase();
      const location = String(item?.location || "").toLowerCase();
      return company.includes(query) || title.includes(query) || location.includes(query);
    });
  }, [loadedItems, searchQuery, atsFilter, countryFilter, locationFilter, remoteFilter]);

  const loadNextChunk = useCallback(async () => {
    if (!meta || loadingChunk) return;
    const nextChunk = Array.isArray(meta?.chunks) ? meta.chunks[loadedChunkCount] : null;
    const nextChunkFile = String(nextChunk?.file || "").trim();
    if (!nextChunkFile) {
      setError("No additional chunk data is available right now.");
      return;
    }

    try {
      setLoadingChunk(true);
      const response = await fetch(`${dataBaseUrl}${nextChunkFile}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${nextChunkFile} request failed (${response.status})`);
      }
      const payload = await response.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setLoadedItems((previous) => [...previous, ...items]);
      setLoadedChunkCount((value) => value + 1);
    } catch (loadError) {
      setError(String(loadError?.message || loadError));
    } finally {
      setLoadingChunk(false);
    }
  }, [dataBaseUrl, loadedChunkCount, loadingChunk, meta]);

  useEffect(() => {
    if (!hasMoreChunks || loadingChunk || loadingIndex || error) return;
    const sentinelNode = loadMoreSentinelRef.current;
    if (!sentinelNode || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        loadNextChunk();
      },
      { root: null, rootMargin: "500px 0px", threshold: 0 }
    );

    observer.observe(sentinelNode);
    return () => observer.disconnect();
  }, [error, hasMoreChunks, loadNextChunk, loadingChunk, loadingIndex]);

  const applySearch = () => {
    setSearchQuery(searchInput);
  };

  const clearFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setAtsFilter("all");
    setCountryFilter("all");
    setLocationFilter("all");
    setRemoteFilter("all");
  };

  const syncStatusText = meta?.reference_iso
    ? `Last sync snapshot: ${meta.reference_iso}`
    : loadingIndex
      ? "Loading sync status..."
      : "No sync status yet.";

  return (
    <Layout title="OpenPostings Lite" description="Slim postings feed built for GitHub Pages static hosting.">
      <main className={styles.page}>
        <section className={styles.headerCard}>
          <div className={styles.headerTopRow}>
            <h1 className={styles.title} style={{ textAlign: "center" }}>OpenPostings Lite</h1>
          </div>
          <p className={styles.subtitle} style={{ textAlign: "center" }}>
            The lite version of OpenPostings (Core)
          </p>
          {meta ? (
            <div className={styles.metaRow}>
              <span>Generated: {meta.reference_iso || meta.generated_at || "Unknown"}</span>
              <span>Window: last {meta.window_hours || 24}h</span>
              <span>Total postings: {Number(meta.total_items || 0).toLocaleString()}</span>
              <span>Chunks: {Number(meta.total_chunks || 0).toLocaleString()}</span>
            </div>
          ) : null}
        </section>

        <section className={styles.filterCard}>
          <div className={styles.sectionTitle}>Postings</div>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Search company or title"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applySearch();
              }}
            />
            <button
              type="button"
              className={styles.primaryActionButton}
              onClick={applySearch}
            >
              Find Jobs
            </button>
          </div>
          <div className={styles.controlsRow}>
            <select className={styles.selectInput} value={atsFilter} onChange={(event) => setAtsFilter(event.target.value)}>
              <option value="all">All ATS (loaded chunks)</option>
              {atsOptions.map((ats) => (
                <option key={ats} value={ats}>
                  {ats}
                </option>
              ))}
            </select>
            <select
              className={styles.selectInput}
              value={countryFilter}
              onChange={(event) => {
                setCountryFilter(event.target.value);
                setLocationFilter("all");
              }}
            >
              <option value="all">All Countries</option>
              {countryOptions.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>
            <select className={styles.selectInput} value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}>
              <option value="all">All Locations</option>
              {locationOptions.map((location) => (
                <option key={location} value={location}>
                  {location}
                </option>
              ))}
            </select>
            <button type="button" className={styles.clearButton} onClick={clearFilters}>
              Clear
            </button>
          </div>
          <div className={styles.remoteFilterGroup}>
            <div className={styles.remoteFilterLabel}>Remote Filter</div>
            <div className={styles.remoteFilterChipsRow}>
              {REMOTE_FILTER_OPTIONS.map((option) => {
                const selected = remoteFilter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${styles.remoteFilterChip} ${selected ? styles.remoteFilterChipActive : ""}`.trim()}
                    onClick={() => setRemoteFilter(option.value)}
                  >
                    <span className={`${styles.remoteFilterChipText} ${selected ? styles.remoteFilterChipTextActive : ""}`.trim()}>
                      {option.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className={styles.syncStatus}>{syncStatusText}</div>
          <div className={styles.filterSummary} style={{ textAlign: "center" }}>
            Loaded {loadedItems.length.toLocaleString()} postings from {loadedChunkCount.toLocaleString()} chunk
            {loadedChunkCount === 1 ? "" : "s"}.
            Showing {filteredItems.length.toLocaleString()} after filters.
          </div>
        </section>

        {loadingIndex ? <LoadingState /> : null}
        {!loadingIndex && error ? <ErrorState message={error} /> : null}
        {!loadingIndex && !error && filteredItems.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>No postings in current result set</div>
            <div className={styles.emptySubtitle}>Load more chunks or adjust filters.</div>
          </div>
        ) : null}

        {!loadingIndex && !error && filteredItems.length > 0 ? (
          <section className={styles.list}>
            {filteredItems.map((item) => (
              <article key={item.id || item.job_posting_url} className={styles.card}>
                <h2 className={styles.cardTitle}>{item.position_name || "Untitled Position"}</h2>
                <div className={styles.cardCompany}>{item.company_name || "Unknown Company"}</div>
                <div className={styles.cardMeta}>ATS: {item.ats || "unknown"}</div>
                <div className={styles.cardMeta}>Location: {item.location || "Location unavailable"}</div>
                <div className={styles.cardMeta}>Country: {getCountryForItem(item)}</div>
                <div className={styles.cardMeta}>Remote: {getRemoteModeLabel(getRemoteModeForItem(item))}</div>
                <div className={styles.cardMeta}>Posting date: {formatPostingDate(item.posting_date, item.posting_epoch)}</div>
                <a className={styles.cardUrl} href={item.job_posting_url} target="_blank" rel="noreferrer">
                  {item.job_posting_url}
                </a>
              </article>
            ))}
          </section>
        ) : null}

        {!loadingIndex && !error && hasMoreChunks ? (
          <div className={styles.loadMoreHint} ref={loadMoreSentinelRef}>
            {loadingChunk ? "Loading more jobs..." : "Scroll down to load more jobs"}
          </div>
        ) : null}
      </main>
    </Layout>
  );
}
