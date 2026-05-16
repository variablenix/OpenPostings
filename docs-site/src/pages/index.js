import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
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
  const loadMoreSentinelRef = useRef(null);

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
    if (!meta || loadingChunk || loadedChunkCount > 0) return;
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
  }, [meta, loadingChunk, loadedChunkCount, dataBaseUrl]);

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

  const filteredItems = useMemo(() => {
    const query = String(searchQuery || "").trim().toLowerCase();
    return loadedItems.filter((item) => {
      const matchesAts = atsFilter === "all" || String(item?.ats || "").trim() === atsFilter;
      if (!matchesAts) return false;
      if (!query) return true;
      const company = String(item?.company_name || "").toLowerCase();
      const title = String(item?.position_name || "").toLowerCase();
      const location = String(item?.location || "").toLowerCase();
      return company.includes(query) || title.includes(query) || location.includes(query);
    });
  }, [loadedItems, searchQuery, atsFilter]);

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
            <h1 className={styles.title}>OpenPostings Lite</h1>
            <Link className={styles.docsLink} to="/docs/intro">
              Docs
            </Link>
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
            <button type="button" className={styles.clearButton} onClick={clearFilters}>
              Clear
            </button>
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
