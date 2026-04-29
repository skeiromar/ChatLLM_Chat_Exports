/*
 * Abacus ChatLLM — ID Collector (console script)
 * ───────────────────────────────────────────────
 * Paste this into the browser console on the Abacus ChatLLM page.
 * It ONLY collects conversation IDs and titles — no clicking, no rendering.
 * Takes about 30–90 seconds depending on how many chats you have.
 *
 * Output: abacus-ids.json
 *   { ids: [ { id, title, url }, … ], appId, capturedAt }
 *
 * Then pass abacus-ids.json to the offline fetcher:
 *   node abacus-offline-fetcher/index.js --ids abacus-ids.json --cookies cookies.txt
 */

(async () => {

  /* ── CONFIG ─────────────────────────────── */
  const SCROLL_PAUSE_MS   = 700;   // wait between scroll steps
  const MAX_SCROLL_PASSES = 300;   // safety ceiling
  const STABLE_PASSES     = 4;     // stop when count unchanged this many times
  const MODE              = "chats"; // "chats" or "projects"
  /* ────────────────────────────────────────── */

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* Status badge */
  const badge = document.createElement("div");
  badge.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999999;background:#1e293b;color:#e2e8f0;padding:10px 14px;border-radius:8px;font:12px/1.4 monospace;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:360px;white-space:pre-wrap;border:1px solid #334155";
  document.body.appendChild(badge);
  const say = t => { badge.textContent = t; };

  /* Get appId from URL */
  const appId = new URLSearchParams(location.search).get("appId") || "";
  if (!appId) say("⚠ No appId in URL — IDs will still be collected.");

  /* Find the sidebar scroll container.
     It is a Radix accordion content div:
       <div role="region" data-state="open" id="radix-..."> */
  function findScroller() {
    // The container holding the chat rows
    const container = document.querySelector('[data-id="containerFiltered"]');
    if (!container) return document.scrollingElement;
    // Walk up to find the scrollable parent
    let el = container;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    // Fallback: the Radix region
    return document.querySelector('[role="region"][data-state="open"]')
        || document.scrollingElement;
  }

  /* Snapshot all current chat rows from the DOM.
     Rows look like: <div id="task-convo-<hex>" …>
     They live inside [data-id="containerFiltered"].
     Date headers ("Today", "Yesterday") do NOT have task-convo ids — we skip them. */
  function snapshot() {
    const container = document.querySelector('[data-id="containerFiltered"]');
    if (!container) return new Map();

    const map = new Map();
    // Direct-child divs of containerFiltered
    for (const outer of container.children) {
      // The actual chat row has a child div with id="task-convo-…"
      const inner = outer.querySelector(':scope > div[id^="task-convo-"]');
      if (!inner) continue;

      const convoId = inner.id.replace(/^task-convo-/, "").trim();
      if (!convoId || map.has(convoId)) continue;

      // Title: span[data-state] inside the inner div
      let title = "";
      const titleSpan = inner.querySelector('span[data-state]');
      if (titleSpan) title = titleSpan.textContent.trim();
      if (!title) {
        const anySpan = inner.querySelector("span");
        if (anySpan) title = anySpan.textContent.trim();
      }

      const url = `https://apps.abacus.ai/chatllm/?appId=${appId}&convoId=${convoId}`;
      map.set(convoId, { id: convoId, title: title || convoId, url });
    }
    return map;
  }

  /* Scroll & collect */
  say("Collecting chat IDs…\nScrolling sidebar…");

  const scroller = findScroller();
  if (!scroller) {
    badge.style.borderColor = "#f87171";
    say("❌ Could not find sidebar scroller.\nMake sure the Chats sidebar is visible.");
    return;
  }

  scroller.scrollTop = 0;
  await sleep(300);

  const found = new Map();
  let stable = 0, lastCount = -1;

  for (let pass = 0; pass < MAX_SCROLL_PASSES; pass++) {
    const snap = snapshot();
    let added = 0;
    for (const [id, item] of snap) {
      if (!found.has(id)) { found.set(id, item); added++; }
    }

    if (found.size === lastCount) {
      stable++;
    } else {
      stable = 0;
      lastCount = found.size;
    }

    say(`Collecting IDs…  found: ${found.size}  (pass ${pass + 1})`);

    if (stable >= STABLE_PASSES) break;

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(SCROLL_PAUSE_MS);
  }

  /* Scroll back to top */
  scroller.scrollTop = 0;

  const ids = Array.from(found.values());
  say(`Found ${ids.length} chats. Downloading…`);

  /* Download */
  const payload = {
    appId,
    mode: MODE,
    capturedAt: new Date().toISOString(),
    count: ids.length,
    ids,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "abacus-ids.json";
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();

  badge.style.background = "#14532d";
  badge.style.borderColor = "#22c55e";
  say(`✓ Done! Downloaded abacus-ids.json\n${ids.length} conversations collected.\n\nNext step: run the offline fetcher:\n  node abacus-offline-fetcher/index.js`);

  setTimeout(() => badge.remove(), 20000);
})();
