(async () => {
  const params   = new URLSearchParams(location.search);
  const token    = params.get("token");
  const original = params.get("url");

  // UI refs
  const spinner       = document.getElementById("spinner");
  const checkIcon     = document.getElementById("check-icon");
  const headline      = document.getElementById("headline");
  const subtitle      = document.getElementById("subtitle");
  const sourceUrl     = document.getElementById("source-url");
  const progressFill  = document.getElementById("progress-fill");
  const progressStatus= document.getElementById("progress-status");
  const progressTime  = document.getElementById("progress-time");
  const progressWrap  = document.getElementById("progress-wrap");
  const resultEl      = document.getElementById("result");
  const finalUrlText  = document.getElementById("final-url-text");
  const variantsEl    = document.getElementById("variants");

  if (original) {
    sourceUrl.textContent  = original;
    document.title = `Resolving ${original}`;
  }

  // Progress animation — fills to 90% over ~4s, then jumps to 100% on done
  const startAt = Date.now();
  let done = false;

  (function tick() {
    const elapsed = (Date.now() - startAt) / 1000;
    const pct = done ? 100 : Math.min((1 - Math.pow(1 - Math.min(elapsed / 4, 1), 3)) * 90, 90);
    progressFill.style.width = pct + "%";
    progressTime.textContent = elapsed.toFixed(1) + "s";
    if (!done) requestAnimationFrame(tick);
  })();

  progressStatus.textContent = "Following redirects…";

  // Tracking params to strip (utm_* caught by prefix check below)
  const TRACKERS = new Set([
    "fbclid","gclid","gclsrc","dclid","gbraid","wbraid",
    "msclkid","mc_eid","mc_cid","twclid","igshid","s_cid","yclid",
    "ref","referral","source","affiliate","_ga","_gl",
  ]);

  /**
   * Decodes a URL that contains mixed HTML entities and percent-encoding
   * into the final clean URL that the browser would actually load.
   * 
   * This function handles complex real-world cases like:
   *   - &amp; → &
   *   - &#38; → &
   *   - %26 → &
   *   - Nested combinations such as &#38;amp%3B → &
   * 
   * It repeatedly applies HTML entity decoding and percent-decoding
   * until no more changes occur.
   * 
   * Examples:
   * 
   * Input:  "https://example.com?a=1&amp;b=2"
   * Output: "https://example.com?a=1&b=2"
   * 
   * Input:  "https://example.com/search?q=hello%20world&amp;lang=en"
   * Output: "https://example.com/search?q=hello world&lang=en"
  */
  function decodeMixedURL(input) {
    if (!input || typeof input !== 'string') return input;

    let url = input.trim();

    // Repeated full decoding cycle until no more changes
    let previous;
    do {
        previous = url;

        // 1. Decode HTML entities (&#38;, &amp;, &#x26;, etc.)
        const textarea = document.createElement('textarea');
        textarea.innerHTML = url;
        url = textarea.value;

        // 2. Decode percent-encoding
        try {
            url = decodeURIComponent(url);
        } catch (e) {
            // If decode fails, try replacing common broken patterns manually
            url = url.replace(/%26/g, '&')
                     .replace(/%3B/g, ';')
                     .replace(/%3D/g, '=');
        }

    } while (url !== previous && url.length < 2000); // safety limit

    // Final cleanup
    try {
        url = decodeURI(url);
    } catch (e) {}

    return url;
}

  function stripTracking(url) {
    try {
      const u = new URL(url);
      const kept = new URLSearchParams();
      for (const [k, v] of u.searchParams) {
        const kl = k.toLowerCase();
        if (!kl.startsWith("utm_") && !TRACKERS.has(kl)) kept.append(k, v);
      }
      u.search = kept.toString();
      return u.toString();
    } catch { return url; }
  }

  function stripAllParams(url) {
    try {
      const u = new URL(url);
      u.search = "";
      u.hash   = "";
      return u.toString();
    } catch { return url; }
  }

  function makeVariantBtn(url, name, desc, primary = false) {
    const btn = document.createElement("a");
    btn.className = "variant-btn" + (primary ? " primary" : "");
    btn.href = url;

    const left = document.createElement("div");
    left.className = "variant-left";

    const nameEl = document.createElement("div");
    nameEl.className = "variant-name";
    nameEl.textContent = name;

    const descEl = document.createElement("div");
    descEl.className = "variant-desc";
    descEl.textContent = desc;

    left.appendChild(nameEl);
    left.appendChild(descEl);

    const arrow = document.createElement("span");
    arrow.className = "variant-arrow";
    arrow.textContent = "→";

    btn.appendChild(left);
    btn.appendChild(arrow);
    return btn;
  }

  function showResult(finalUrl) {
    done = true;
    progressFill.style.width = "100%";
    progressStatus.textContent = "Resolved";

    setTimeout(() => {
      // Swap spinner for check, update headline
      spinner.classList.add("done");
      setTimeout(() => {
        spinner.style.display = "none";
        checkIcon.classList.add("visible");
      }, 300);

      headline.textContent = "Where do you want to go?";
      subtitle.textContent = "Choose how to open this link";
      progressWrap.style.display = "none";

      const finalUrlSanitized = decodeMixedURL(finalUrl);

      finalUrlText.textContent = finalUrlSanitized;

      const noTracking = stripTracking(finalUrlSanitized);
      const noParams   = stripAllParams(finalUrlSanitized);

      // Always show full URL as primary CTA
      variantsEl.appendChild(makeVariantBtn(
        finalUrlSanitized,
        "Open full URL",
        finalUrlSanitized,
        true
      ));

      // Only show if actually different
      if (noTracking !== finalUrlSanitized) {
        variantsEl.appendChild(makeVariantBtn(
          noTracking,
          "Remove known tracking parameters",
          noTracking,
          false
        ));
      }

      if (noParams !== finalUrlSanitized) {
        variantsEl.appendChild(makeVariantBtn(
          noParams,
          "Remove all parameters",
          noParams,
          false
        ));
      }

      resultEl.style.display = "flex";
    }, 200);
  }

  // Poll background every 200ms
  async function poll() {
    try {
      const res = await browser.runtime.sendMessage({ type: "CHECK_RESOLUTION", token });
      if (res?.done) { showResult(res.url); return; }
    } catch { /* background not ready yet */ }
    setTimeout(poll, 200);
  }

  setTimeout(poll, 100);
})();
