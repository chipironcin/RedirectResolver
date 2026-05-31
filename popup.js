// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ── Domains ───────────────────────────────────────────────────────────────
let domains = [];

const isValidPattern = p =>
  /^(\*|https?|ftp):\/\/[^/]+\/.+$/.test(p.trim()) || p.trim() === "<all_urls>";

async function loadDomains() {
  const { domains: d } = await browser.runtime.sendMessage({ type: "GET_DOMAINS" });
  domains = d || [];
  renderDomains();
}

async function saveDomains() {
  await browser.runtime.sendMessage({ type: "SET_DOMAINS", domains });
  updateStatus();
}

function renderDomains() {
  const list = document.getElementById("domain-list");
  list.textContent = "";

  const active = domains.filter(d => d.enabled).length;
  document.getElementById("domain-count").textContent =
    `${domains.length} domain${domains.length !== 1 ? "s" : ""} · ${active} active`;

  if (!domains.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const s = document.createElement("strong");
    s.textContent = "No domains";
    empty.appendChild(s);
    empty.appendChild(document.createTextNode(" — add a pattern above."));
    list.appendChild(empty);
    return;
  }

  domains.forEach((d, i) => {
    const row = document.createElement("div");
    row.className = "domain-row" + (d.enabled ? "" : " disabled");

    // Toggle
    const lbl = document.createElement("label");
    lbl.className = "toggle";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = d.enabled;
    chk.addEventListener("change", async () => {
      domains[i].enabled = chk.checked;
      await saveDomains();
      renderDomains();
    });
    const track = document.createElement("div");
    track.className = "toggle-track";
    const thumb = document.createElement("div");
    thumb.className = "toggle-thumb";
    lbl.appendChild(chk);
    lbl.appendChild(track);
    lbl.appendChild(thumb);

    // Info
    const info = document.createElement("div");
    info.className = "domain-info";
    const name = document.createElement("div");
    name.className = "domain-name";
    name.textContent = d.label || d.pattern;
    const pat = document.createElement("div");
    pat.className = "domain-pattern";
    pat.textContent = d.pattern;
    info.appendChild(name);
    info.appendChild(pat);

    // Delete
    const del = document.createElement("button");
    del.className = "btn-del";
    del.textContent = "×";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      const removed = domains.splice(i, 1)[0];
      await saveDomains();
      renderDomains();
      showToast(`Removed "${removed.label || removed.pattern}"`);
    });

    row.appendChild(lbl);
    row.appendChild(info);
    row.appendChild(del);
    list.appendChild(row);
  });
}

document.getElementById("btn-add").addEventListener("click", addDomain);
document.getElementById("new-pattern").addEventListener("keydown", e => {
  if (e.key === "Enter") addDomain();
});

async function addDomain() {
  const input = document.getElementById("new-pattern");
  const raw = input.value.trim();
  if (!raw) return;
  if (!isValidPattern(raw)) {
    input.classList.add("error");
    showToast("Invalid pattern — use *://host/*", "err");
    setTimeout(() => input.classList.remove("error"), 1200);
    return;
  }
  let label = raw;
  try { label = new URL(raw.replace(/^\*/, "https")).hostname.replace(/^\*\./, ""); } catch {}
  domains.push({ label, pattern: raw, enabled: true });
  input.value = "";
  await saveDomains();
  renderDomains();
  showToast(`Added ${label}`);
}

document.getElementById("btn-reset").addEventListener("click", async () => {
  const { domains: defaults } = await browser.runtime.sendMessage({ type: "GET_DEFAULTS" });
  domains = defaults || [];
  await browser.storage.local.remove("userDomains");
  await browser.runtime.sendMessage({ type: "SET_DOMAINS", domains });
  renderDomains();
  showToast("Reset to defaults");
});

// ── Overview ──────────────────────────────────────────────────────────────
let sessionCount = 0;

function formatUrl(url, max = 48) {
  try {
    const u = new URL(url);
    const s = u.hostname + u.pathname + u.search;
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return url.length > max ? url.slice(0, max) + "…" : url;
  }
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)    return "just now";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function updateStatus() {
  const active = domains.filter(d => d.enabled).length;
  document.getElementById("status-text").textContent =
    active ? `Active on ${active} domain${active !== 1 ? "s" : ""}` : "No domains active";
}

async function renderOverview() {
  const { stats } = await browser.storage.local.get({ stats: { total: 0, recent: [] } });
  document.getElementById("stat-total").textContent  = stats.total;
  document.getElementById("stat-session").textContent = sessionCount;
  document.getElementById("total-badge").textContent = stats.total;

  const hist = document.getElementById("history");
  hist.textContent = "";

  if (!stats.recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const s = document.createElement("strong");
    s.textContent = "No resolutions yet";
    empty.appendChild(s);
    empty.appendChild(document.createTextNode(" — click a short-link to get started."));
    hist.appendChild(empty);
    return;
  }

  stats.recent.forEach(e => {
    const entry = document.createElement("div");
    entry.className = "entry";

    const from = document.createElement("div");
    from.className = "entry-from";
    from.textContent = formatUrl(e.original, 44);

    const to = document.createElement("div");
    to.className = "entry-to";
    to.title = e.resolved;
    to.textContent = formatUrl(e.resolved, 44);
    to.addEventListener("click", () => browser.tabs.create({ url: e.resolved }));

    const time = document.createElement("div");
    time.className = "entry-time";
    time.textContent = timeAgo(e.ts);

    entry.appendChild(from);
    entry.appendChild(to);
    entry.appendChild(time);
    hist.appendChild(entry);
  });
}

document.getElementById("clear-btn").addEventListener("click", async () => {
  await browser.storage.local.set({ stats: { total: 0, recent: [] } });
  sessionCount = 0;
  renderOverview();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) {
    const diff = (changes.stats.newValue?.total ?? 0) - (changes.stats.oldValue?.total ?? 0);
    sessionCount += diff;
    renderOverview();
  }
  if (changes.userDomains) loadDomains();
});

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  await loadDomains();
  await renderOverview();
  updateStatus();
})();
