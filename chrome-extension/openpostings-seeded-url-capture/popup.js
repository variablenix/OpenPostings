const DEFAULT_BACKEND_URL = "http://localhost:8787";
const STORAGE_KEYS = {
  backendUrl: "openpostings_backend_url"
};

const state = {
  classification: null,
  checking: false
};

const elements = {
  backendUrl: document.getElementById("backendUrl"),
  sourceUrl: document.getElementById("sourceUrl"),
  classifyBtn: document.getElementById("classifyBtn"),
  addBtn: document.getElementById("addBtn"),
  matchState: document.getElementById("matchState"),
  atsValue: document.getElementById("atsValue"),
  identifierValue: document.getElementById("identifierValue"),
  companyName: document.getElementById("companyName"),
  message: document.getElementById("message")
};

function normalizeBackendUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_BACKEND_URL;
  return raw.replace(/\/+$/, "");
}

function setMessage(text, type = "") {
  elements.message.textContent = String(text || "");
  elements.message.className = type ? `message ${type}` : "message";
}

function renderClassification(result) {
  state.classification = result || null;
  if (!result) {
    elements.matchState.textContent = "Not checked";
    elements.atsValue.textContent = "-";
    elements.identifierValue.textContent = "-";
    elements.addBtn.disabled = true;
    return;
  }

  if (result.supported) {
    elements.matchState.textContent = "Seeded ATS match";
    elements.atsValue.textContent = String(result.ats_label || result.ats || "-");
    elements.identifierValue.textContent = String(result.company_identifier || "-");
    elements.addBtn.disabled = false;

    if (!String(elements.companyName.value || "").trim()) {
      elements.companyName.value = String(result.suggested_company_name || result.company_identifier || "").trim();
    }
    if (result.canonical_url) {
      elements.sourceUrl.value = String(result.canonical_url);
    }
    return;
  }

  elements.matchState.textContent = String(result.message || result.reason || "Unsupported");
  elements.atsValue.textContent = String(result.ats || "-");
  elements.identifierValue.textContent = "-";
  elements.addBtn.disabled = true;
}

async function postJson(path, payload) {
  const backendUrl = normalizeBackendUrl(elements.backendUrl.value);
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const errorText = String(data?.error || `HTTP ${response.status}`);
    throw new Error(errorText);
  }
  return data;
}

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.backendUrl]);
  const backendUrl = normalizeBackendUrl(stored?.[STORAGE_KEYS.backendUrl] || DEFAULT_BACKEND_URL);
  elements.backendUrl.value = backendUrl;
}

async function persistSettings() {
  const backendUrl = normalizeBackendUrl(elements.backendUrl.value);
  await chrome.storage.local.set({
    [STORAGE_KEYS.backendUrl]: backendUrl
  });
}

async function loadCurrentTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = String(tabs?.[0]?.url || "").trim();
  if (url && url !== "chrome://newtab/") {
    elements.sourceUrl.value = url;
  }
}

async function classifyCurrentUrl() {
  if (state.checking) return;
  state.checking = true;
  elements.classifyBtn.disabled = true;
  elements.classifyBtn.textContent = "Checking...";
  setMessage("");
  const sourceUrl = String(elements.sourceUrl.value || "").trim();
  if (!sourceUrl) {
    renderClassification(null);
    setMessage("Enter a URL to classify.", "error");
    state.checking = false;
    elements.classifyBtn.disabled = false;
    elements.classifyBtn.textContent = "Check URL";
    return;
  }

  try {
    await persistSettings();
    const data = await postJson("/extension/seeded-source/classify", { url_string: sourceUrl });
    renderClassification(data?.item || null);
    if (data?.item?.supported) {
      const atsName = String(data.item.ats_label || data.item.ats || "ATS");
      setMessage(`Seeded ATS URL confirmed (${atsName}).`, "success");
    } else {
      setMessage(String(data?.item?.message || "URL is not a supported seeded ATS source."), "error");
    }
  } catch (error) {
    renderClassification(null);
    setMessage(String(error?.message || error), "error");
  } finally {
    state.checking = false;
    elements.classifyBtn.disabled = false;
    elements.classifyBtn.textContent = "Check URL";
  }
}

async function addSeededSource() {
  setMessage("");
  const classification = state.classification;
  if (!classification?.supported) {
    setMessage("Classify a supported seeded ATS URL first.", "error");
    return;
  }

  const sourceUrl = String(elements.sourceUrl.value || "").trim();
  const companyName = String(elements.companyName.value || "").trim();
  if (!sourceUrl) {
    setMessage("Source URL is required.", "error");
    return;
  }
  if (!companyName) {
    setMessage("Company name is required.", "error");
    return;
  }

  try {
    await persistSettings();
    const data = await postJson("/extension/seeded-source/upsert", {
      url_string: sourceUrl,
      company_name: companyName
    });
    const item = data?.item || {};
    const action = String(item?.action || "saved");
    const ats = String(item?.ATS_name || classification.ats || "");
    setMessage(`Saved (${action}) - ATS: ${ats}`, "success");
    if (item?.url_string) {
      elements.sourceUrl.value = String(item.url_string);
    }
    if (item?.company_name) {
      elements.companyName.value = String(item.company_name);
    }
  } catch (error) {
    setMessage(String(error?.message || error), "error");
  }
}

async function bootstrap() {
  await loadStoredSettings();
  await loadCurrentTabUrl();
  await classifyCurrentUrl();
}

elements.classifyBtn.addEventListener("click", classifyCurrentUrl);
elements.addBtn.addEventListener("click", addSeededSource);
elements.backendUrl.addEventListener("change", persistSettings);
elements.sourceUrl.addEventListener("input", () => {
  renderClassification(null);
  setMessage("");
});

bootstrap().catch((error) => {
  setMessage(String(error?.message || error), "error");
});

