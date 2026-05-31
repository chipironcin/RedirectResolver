/**
 * Redirect Resolver — Background Script
 *
 * Reads domain patterns from redirects.json (bundled config) and from
 * browser.storage.local (user overrides).  Registers a blocking webRequest
 * listener for all enabled patterns.  When the user edits the domain list
 * via the popup the listener is torn down and rebuilt automatically.
 *
 * Flow per intercepted request:
 *  1. Main-frame navigation to a matched URL is intercepted & cancelled.
 *  2. Tab is redirected to resolving.html?token=…&url=… immediately.
 *  3. Background follows the redirect chain via fetch(redirect:"manual").
 *  4. resolving.html polls via runtime.sendMessage {type:"CHECK_RESOLUTION"}.
 *  5. Once done, resolving.html shows the result and three action buttons.
 *     The user chooses where to go — no auto-navigation.
 */

// ── Job / cache / guard stores ────────────────────────────────────────────
const jobs         = new Map();   // token → { done, url }
const resolvedCache = new Map();  // original url → final url (session)
const inFlight     = new Set();   // "tabId:url" keys currently being handled

// ── Active listener handle (so we can remove & re-add it) ─────────────────
let currentListener   = null;
let currentPatterns   = [];       // the URL patterns the listener is bound to

// ── Token generator ───────────────────────────────────────────────────────
function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─────────────────────────────────────────────────────────────────────────
// CONFIG LOADING
// Merges bundled redirects.json with any user overrides stored locally.
// User overrides win: they can toggle/add/remove entries.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Load bundled redirects.json.
 * Returns the parsed { domains: [...] } object.
 */
async function loadBundledConfig() {
  try {
    const url      = browser.runtime.getURL("redirects.json");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("[resolver] failed to load redirects.json:", err);
    return { domains: [] };
  }
}

/**
 * Merge bundled config with user overrides from storage.
 *
 * Storage key "userDomains" holds an array of domain objects that completely
 * replaces the bundled list when present.  This lets the popup editor write
 * the full list without knowing about the bundled defaults.
 *
 * Returns an array of { label, pattern, enabled } objects.
 */
async function loadDomains() {
  const stored = await browser.storage.local.get({ userDomains: null });
  if (stored.userDomains !== null) {
    // User has customised the list — use it entirely
    return stored.userDomains;
  }
  // No customisation yet — use the bundled defaults
  const cfg = await loadBundledConfig();
  return cfg.domains || [];
}

// ─────────────────────────────────────────────────────────────────────────
// LISTENER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

function buildListener(patterns) {
  return (details) => {
    const { url, tabId } = details;

    // Loop guard
    const guardKey = `${tabId}:${url}`;
    if (inFlight.has(guardKey)) return {};
    inFlight.add(guardKey);

    const token = makeToken();
    jobs.set(token, { done: false, url });

    const resolvingPage =
      browser.runtime.getURL("resolving.html") +
      "?token=" + encodeURIComponent(token) +
      "&url="   + encodeURIComponent(url);

    browser.tabs.update(tabId, { url: resolvingPage }).catch(() => {});

    resolveUrl(url)
      .then(finalUrl => {
        console.log(`[resolver] ${url} → ${finalUrl}`);
        jobs.set(token, { done: true, url: finalUrl });
        recordResolution(url, finalUrl);
        setTimeout(() => jobs.delete(token), 120_000);
      })
      .catch(err => {
        console.error("[resolver] resolution error:", err);
        jobs.set(token, { done: true, url }); // fail open: send to original
      })
      .finally(() => {
        inFlight.delete(guardKey);
      });

    return { cancel: true };
  };
}

/**
 * (Re)register the webRequest listener for the given URL patterns.
 * Safely removes the previous listener first.
 */
function applyListener(patterns) {
  // Remove old listener if any
  if (currentListener) {
    try {
      browser.webRequest.onBeforeRequest.removeListener(currentListener);
    } catch { /* already gone */ }
    currentListener = null;
    currentPatterns = [];
  }

  if (!patterns.length) {
    console.log("[resolver] no enabled patterns — listener not registered.");
    return;
  }

  currentListener = buildListener(patterns);
  currentPatterns = patterns;

  browser.webRequest.onBeforeRequest.addListener(
    currentListener,
    { urls: patterns, types: ["main_frame"] },
    ["blocking"]
  );

  console.log("[resolver] listening on:", patterns);
}

/**
 * Load config and (re)apply the listener.  Called at startup and whenever
 * the domain list changes.
 */
async function reloadConfig() {
  const domains  = await loadDomains();
  const patterns = domains
    .filter(d => d.enabled)
    .map(d => d.pattern);
  applyListener(patterns);
}

// ─────────────────────────────────────────────────────────────────────────
// REDIRECT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────

async function resolveUrl(startUrl, maxHops = 10) {
  if (resolvedCache.has(startUrl)) return resolvedCache.get(startUrl);

  let current = startUrl;
  let hops    = 0;

  while (hops < maxHops) {
    hops++;
    let response;
    try {
      response = await fetch(current, {
        method:      "GET",
        redirect:    "manual",
        credentials: "omit",
        cache:       "no-store",
        // No custom headers — let the browser send its natural defaults.
        // Shorteners like t.co fingerprint the User-Agent and return an HTML
        // soft-redirect instead of a clean 3xx when they detect a spoofed UA.
      });
    } catch (err) {
      console.warn(`[resolver] fetch error hop ${hops} for ${current}:`, err);
      break;
    }

    // With redirect:"manual", the browser never exposes a real 3xx status.
    // Redirects surface as type "opaqueredirect" with status 0.
    // A true final response has type "basic" or "cors" with a real 2xx/4xx/5xx.
    if (response.type === "opaqueredirect") {
      const loc = response.headers.get("location");
      if (!loc) break; // redirect with no Location — stop here
      try { current = new URL(loc, current).href; } catch { current = loc; }
      continue;
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
      // Could still be a client-side redirect (meta refresh or JS location).
      // Only parse HTML bodies — skip if too large (>50 KB) to avoid hanging.
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        try {
          const text = await Promise.race([
            response.text(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))
          ]);
          // Normalise: collapse whitespace so multi-line attributes are findable
          const compact = text.slice(0, 50000).replace(/\s+/g, " ");

          // 1. <meta http-equiv="refresh" content="0; url=https://…">
          const metaMatch = compact.match(
            /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'>\s]+)/i
          ) || compact.match(
            /<meta[^>]+content=["']?\d+;\s*url=([^"'>\s]+)[^>]+http-equiv=["']?refresh["']?/i
          );
          if (metaMatch) {
            const dest = metaMatch[1].replace(/["']/g, "").trim();
            try { current = new URL(dest, current).href; } catch { current = dest; }
            continue;
          }

          // 2. window.location = "…" / window.location.href = "…" / location.replace("…")
          const jsMatch = compact.match(
            /window\.location(?:\.href)?\s*=\s*["']([^"'`]+)["']|location\.replace\s*\(\s*["']([^"'`]+)["']\s*\)/i
          );
          if (jsMatch) {
            const dest = (jsMatch[1] || jsMatch[2]).trim();
            try { current = new URL(dest, current).href; } catch { current = dest; }
            continue;
          }
        } catch (parseErr) {
          console.warn("[resolver] body parse error:", parseErr);
        }
      }
      // No client-side redirect found — this is the real final destination
      break;
    }

    break; // 4xx / 5xx — accept current as best-effort destination
  }

  resolvedCache.set(startUrl, current);
  return current;
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────

async function recordResolution(original, resolved) {
  try {
    const data  = await browser.storage.local.get({ stats: { total: 0, recent: [] } });
    const stats = data.stats;
    stats.total += 1;
    stats.recent.unshift({ original, resolved, ts: Date.now() });
    if (stats.recent.length > 50) stats.recent.length = 50;
    await browser.storage.local.set({ stats });
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE BUS
// ─────────────────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender) => {
  // resolving.html polls for job completion
  if (msg?.type === "CHECK_RESOLUTION") {
    const job = jobs.get(msg.token);
    return Promise.resolve(job ?? { done: false });
  }

  // popup requests the current domain list
  if (msg?.type === "GET_DOMAINS") {
    return loadDomains().then(domains => ({ domains }));
  }

  // popup pushes an updated domain list
  if (msg?.type === "SET_DOMAINS") {
    return browser.storage.local
      .set({ userDomains: msg.domains })
      .then(() => reloadConfig())
      .then(() => ({ ok: true }));
  }

  // popup requests the bundled defaults (for a "reset" action)
  if (msg?.type === "GET_DEFAULTS") {
    return loadBundledConfig().then(cfg => ({ domains: cfg.domains || [] }));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// STORAGE CHANGE WATCHER
// Re-applies the listener if userDomains changes (e.g. from another tab).
// ─────────────────────────────────────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "userDomains" in changes) {
    reloadConfig();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────

reloadConfig().then(() => {
  console.log("[resolver] background script ready.");
});
